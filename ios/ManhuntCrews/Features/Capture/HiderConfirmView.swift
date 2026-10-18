import SwiftUI

/// Hiding operator reviews a catch claim. Confirming finalizes the official
/// time at the server's *submission* time, not now.
struct HiderConfirmView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    let roundId: String
    let request: CaptureRequestView
    let view: SessionViewDoc

    @State private var photo: UIImage?
    @State private var photoError: String?
    @State private var reason = ""
    @State private var showReject = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    Group {
                        if let photo {
                            Image(uiImage: photo).resizable().scaledToFit()
                        } else if let photoError {
                            ContentUnavailableView("Photo unavailable", systemImage: "photo", description: Text(photoError))
                        } else {
                            ProgressView("Loading photo…").frame(height: 260)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.corner))
                    .accessibilityLabel("Catch photo submitted by the seeking crew")

                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        let now = ServerClock.shared.now()
                        VStack(spacing: 6) {
                            if let seek = view.session.team(view.round?.seekingTeam ?? .B) { Text("\(seek.name) claims they caught you").font(.title3.bold()) }
                            Text("Submitted \(Fmt.time(request.submittedAt))\(request.chaseSecondsAtClaim.map { " · chase time \(Fmt.clock(Double($0)))" } ?? "")")
                            if let exp = request.expiresAt {
                                let left = exp.timeIntervalSince(now)
                                Text(left > 0 ? "Decide within \(Fmt.clock(left)) — otherwise the round resumes" : "Window expired")
                                    .font(.headline).foregroundStyle(left < 30 ? Theme.danger : .orange)
                            }
                        }
                    }

                    Text("Confirming records the catch at the submission time above. Rejecting resumes the round from the frozen clock; positions during the review are not revealed.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)

                    BigButton(title: "Confirm catch", systemImage: "checkmark.seal.fill", tint: Theme.ok, busy: busy) {
                        perform($busy, $error) { try await model.api.decide(sessionId, roundId, claimId: request.claimId, confirm: true, reason: nil) }
                    }
                    .accessibilityIdentifier("confirm.confirm")
                    BigButton(title: "Reject", systemImage: "xmark.circle.fill", tint: Theme.danger) { showReject = true }
                        .disabled(busy)
                }
                .padding()
            }
            .navigationTitle("Catch claim")
            .navigationBarTitleDisplayMode(.inline)
            .alert("Reject this catch?", isPresented: $showReject) {
                TextField("Reason (optional)", text: $reason)
                Button("Reject", role: .destructive) {
                    perform($busy, $error) { try await model.api.decide(sessionId, roundId, claimId: request.claimId, confirm: false, reason: reason.isEmpty ? nil : reason) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .task {
                do {
                    let data = try await model.api.photo(path: request.photoPath)
                    photo = UIImage(data: data)
                    if photo == nil { photoError = "The photo couldn't be decoded." }
                } catch { photoError = error.localizedDescription }
            }
            .errorAlert($error)
        }
    }
}
