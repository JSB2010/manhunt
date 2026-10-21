import SwiftUI

/// Any hiding-crew phone reviews a catch claim; the first decision counts. Confirming finalizes the official
/// time at the server’s *submission* time, not now.
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

    /// The crew that claimed the catch.
    private var seekers: TeamView? { view.session.team(request.byTeam) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Group {
                        if let photo {
                            Image(uiImage: photo)
                                .resizable()
                                .scaledToFit()
                        } else if let photoError {
                            ContentUnavailableView("Photo Unavailable", systemImage: "photo", description: Text(photoError))
                        } else {
                            ProgressView("Loading photo…").frame(maxWidth: .infinity, minHeight: 260)
                        }
                    }
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.mediaCorner, style: .continuous))
                    .accessibilityLabel("Catch photo submitted by the seeking crew")

                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        let now = ServerClock.shared.now()
                        VStack(spacing: 8) {
                            if let seekers {
                                HStack(spacing: 8) {
                                    CrewDot(key: seekers.key)
                                    Text("\(seekers.name) say they caught you")
                                }
                                .font(.title3.bold())
                                .multilineTextAlignment(.center)
                            }
                            Text("Submitted \(Fmt.time(request.submittedAt))\(request.chaseSecondsAtClaim.map { " · chase time \(Fmt.clock(Double($0)))" } ?? "")")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            if let exp = request.expiresAt {
                                let left = exp.timeIntervalSince(now)
                                Label(left > 0 ? "Decide within \(Fmt.clock(left)) or the round resumes" : "Decision window expired",
                                      systemImage: "timer")
                                    .font(.headline)
                                    .foregroundStyle(left < 30 ? Theme.danger : Theme.warning)
                                    .monospacedDigit()
                                    .accessibilityAddTraits(.updatesFrequently)
                            }
                        }
                    }

                    Text("Confirming records the catch at the submission time.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
            .navigationTitle("Catch Claim")
            .navigationBarTitleDisplayMode(.inline)
            .bottomActionBar {
                GlassGroup(spacing: 12) {
                    HStack(spacing: 12) {
                        Button(role: .destructive) { showReject = true } label: {
                            ActionLabel(title: "Reject", systemImage: "xmark", expands: false)
                        }
                        .floatingButton()
                        .disabled(busy)
                        Button {
                            perform($busy, $error) { try await model.api.decide(sessionId, roundId, claimId: request.claimId, confirm: true, reason: nil) }
                        } label: {
                            ActionLabel(title: "Confirm Catch", systemImage: "checkmark.seal.fill", busy: busy)
                        }
                        .floatingProminentButton()
                        .disabled(busy)
                        .accessibilityIdentifier("confirm.confirm")
                    }
                }
                .controlSize(.large)
            }
            .alert("Reject this catch?", isPresented: $showReject) {
                TextField("Reason (optional)", text: $reason)
                Button("Reject", role: .destructive) {
                    perform($busy, $error) { try await model.api.decide(sessionId, roundId, claimId: request.claimId, confirm: false, reason: reason.isEmpty ? nil : reason) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The round resumes from the frozen clock.")
            }
            .task {
                do {
                    let data = try await model.api.photo(path: request.photoPath)
                    photo = UIImage(data: data)
                    if photo == nil { photoError = "The photo couldn’t be decoded." }
                } catch { photoError = error.localizedDescription }
            }
            .errorAlert($error)
        }
    }
}
