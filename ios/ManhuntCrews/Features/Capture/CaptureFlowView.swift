import SwiftUI
import UIKit

/// Seeker photo catch (spec §3.3): in-app camera → preview → submit.
/// The official capture time is when the server accepts the completed claim,
/// never a local timestamp. Unsent photos are kept encrypted for retry.
struct CaptureFlowView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    let roundId: String

    enum Step: Equatable { case camera, preview, uploading(String), done, failed(String) }

    @State private var step: Step = .camera
    @State private var image: UIImage?
    @State private var jpeg: Data?
    @State private var ticket: CaptureTicket?
    @State private var uploaded = false
    @State private var showCamera = true

    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                switch step {
                case .camera:
                    if cameraAvailable {
                        Color.clear.onAppear { showCamera = true }
                        Text("Opening camera…")
                    } else {
                        ContentUnavailableView("No camera", systemImage: "camera.badge.ellipsis", description: Text("This device has no camera."))
                        #if DEBUG && targetEnvironment(simulator)
                        Button("Use simulator test photo (DEBUG only)") { use(SimulatorTestPhoto.make()) }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("capture.simPhoto")
                        #endif
                    }
                case .preview, .uploading, .failed:
                    if let image {
                        Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: Theme.corner)).frame(maxHeight: 420)
                    }
                    if case let .uploading(stage) = step {
                        ProgressView(stage)
                        Text("Keep the app open. If the network is slow, the catch time is set when the server accepts it.").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    if case let .failed(msg) = step {
                        ErrorBanner(message: msg)
                        Text("No catch was recorded. The clock keeps running. Your photo is saved on this phone for retry.").font(.footnote).multilineTextAlignment(.center)
                    }
                    HStack {
                        Button("Retake") { step = .camera; showCamera = true; ticket = nil; uploaded = false }
                            .buttonStyle(.bordered).disabled(isUploading)
                        BigButton(title: step == .preview ? "Submit catch" : "Retry submit", systemImage: "paperplane.fill", tint: Theme.seeking, busy: isUploading) { submit() }
                            .accessibilityIdentifier("capture.submit")
                    }
                case .done:
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 72)).foregroundStyle(Theme.ok)
                    Text("Catch submitted").font(.title.bold())
                    Text("The chase clock froze at the server's submission time. The hiding crew must confirm.").multilineTextAlignment(.center)
                    Button("Back to map") { dismiss() }.buttonStyle(.borderedProminent).accessibilityIdentifier("capture.backToMap")
                }
            }
            .padding()
            .navigationTitle("Photo catch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(isUploading) } }
            .fullScreenCover(isPresented: Binding(get: { showCamera && cameraAvailable && step == .camera }, set: { showCamera = $0 })) {
                CameraPicker { img in
                    showCamera = false
                    if let img { use(img) } else { dismiss() }
                }
                .ignoresSafeArea()
            }
            .onAppear(perform: restorePending)
        }
    }

    private var isUploading: Bool { if case .uploading = step { return true } else { return false } }

    private func use(_ img: UIImage) {
        image = img
        jpeg = PhotoVault.encode(img)
        if let jpeg { PhotoVault.store(jpeg, roundId: roundId) }
        step = .preview
    }

    private func restorePending() {
        guard image == nil, let data = PhotoVault.load(roundId: roundId), let img = UIImage(data: data) else { return }
        image = img
        jpeg = data
        step = .preview
    }

    private func submit() {
        guard let jpeg else { return }
        Task {
            do {
                if ticket == nil || (ticket.map { $0.expiresAt < Date() } ?? true) {
                    step = .uploading("Requesting upload…")
                    ticket = try await model.api.captureInit(sessionId, roundId)
                    uploaded = false
                }
                guard let ticket else { return }
                if !uploaded {
                    step = .uploading("Uploading photo (\(jpeg.count / 1024) KB)…")
                    try await model.api.capturePhoto(path: ticket.uploadPath, jpeg: jpeg)
                    uploaded = true
                }
                step = .uploading("Submitting catch…")
                try await model.api.captureComplete(sessionId, roundId, claimId: ticket.claimId)
                PhotoVault.remove(roundId: roundId)
                step = .done
            } catch let e as APIError {
                if e.code == "CAPTURE_EXPIRED" { ticket = nil }
                if e.code == "STALE_PHASE" || e.code == "ALREADY_CLAIMED" { PhotoVault.remove(roundId: roundId) }
                step = .failed(e.localizedDescription)
            } catch {
                step = .failed(error.localizedDescription)
            }
        }
    }
}

/// Encrypted local copy of the not-yet-accepted catch photo.
enum PhotoVault {
    static func encode(_ img: UIImage) -> Data? {
        let maxSide: CGFloat = 2048
        let scale = min(1, maxSide / max(img.size.width, img.size.height))
        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        // Re-rendering drops EXIF/GPS metadata on-device; the server strips again.
        return resized.jpegData(compressionQuality: 0.72)
    }
    static func store(_ data: Data, roundId: String) { try? EncryptedStore.write(data, name: "photo-\(roundId).bin") }
    static func load(roundId: String) -> Data? { EncryptedStore.read(name: "photo-\(roundId).bin") }
    static func remove(roundId: String) { EncryptedStore.remove(name: "photo-\(roundId).bin") }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onDone: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = .camera
        p.cameraCaptureMode = .photo
        p.allowsEditing = false
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (UIImage?) -> Void
        init(onDone: @escaping (UIImage?) -> Void) { self.onDone = onDone }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onDone(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone(nil) }
    }
}

#if DEBUG
/// Simulator has no camera. DEBUG-only synthetic photo so the full claim flow
/// can be exercised on simulators; release builds have no such path.
enum SimulatorTestPhoto {
    static func make() -> UIImage {
        let size = CGSize(width: 1200, height: 900)
        return UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor(red: 0.1, green: 0.2, blue: 0.15, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let text = "SIMULATOR TEST CATCH\n\(Date().formatted(date: .omitted, time: .standard))" as NSString
            text.draw(in: CGRect(x: 80, y: 360, width: 1040, height: 300), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 72), .foregroundColor: UIColor.white])
        }
    }
}
#endif
