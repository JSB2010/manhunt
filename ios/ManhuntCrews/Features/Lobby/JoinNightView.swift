import SwiftUI

/// Join as the second operator via code / deep link / direct friend invite.
struct JoinNightView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var initialCode: String = ""
    var inviteId: String?
    @State private var code = ""
    @State private var preview: InvitePreview?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if inviteId == nil {
                    Section {
                        TextField("8-character code", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .textContentType(.oneTimeCode)
                            .font(.system(.title2, design: .monospaced, weight: .semibold))
                            .submitLabel(.search)
                            .onSubmit { if code.count >= 6 { lookup() } }
                            .accessibilityIdentifier("join.code")
                        Button("Look Up Night") { lookup() }
                            .disabled(code.count < 6 || busy)
                            .accessibilityIdentifier("join.lookup")
                    } header: {
                        Text("Invite code")
                    } footer: {
                        Text("Ask the host for the code shown in their lobby. Codes expire.")
                    }
                }
                if let p = preview {
                    Section(p.title) {
                        LabeledContent("Date", value: Fmt.day(p.scheduledDate))
                        LabeledContent("Host", value: p.hostDisplayName ?? "—")
                        LabeledContent("You’ll operate") {
                            HStack(spacing: 6) {
                                CrewDot(key: p.teamKey)
                                Text(p.teams[p.teamKey.rawValue]?.name ?? p.teamKey.rawValue)
                            }
                        }
                        if let roster = p.teams[p.teamKey.rawValue]?.roster, !roster.isEmpty {
                            LabeledContent("Crew", value: roster.map(\.displayName).formatted(.list(type: .and)))
                        }
                        LabeledContent("Head start", value: "\(p.rules.headStartSeconds / 60) min")
                        LabeledContent("Pings", value: "every \(p.rules.pingIntervalSeconds / 60) min")
                        LabeledContent("Rounds", value: "\(p.rules.totalRounds)")
                    }
                }
                if preview != nil || inviteId != nil {
                    Section {
                    } footer: {
                        Text("Next you’ll review the tracking disclosure before any location is recorded.")
                    }
                }
            }
            .navigationTitle("Join a Night")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } } }
            .bottomActionBar {
                if preview != nil || inviteId != nil {
                    Button { join() } label: { ActionLabel(title: "Join as Operator", systemImage: "person.badge.plus", busy: busy) }
                        .floatingProminentButton()
                        .controlSize(.large)
                        .disabled(busy)
                        .accessibilityIdentifier("join.submit")
                }
            }
            .onAppear {
                if code.isEmpty { code = initialCode }
                if !initialCode.isEmpty { lookup() }
            }
            .errorAlert($error)
        }
    }

    private func lookup() {
        perform($busy, $error) { preview = try await model.api.previewInvite(code: code.uppercased()) }
    }

    private func join() {
        perform($busy, $error) {
            let view = inviteId != nil ? try await model.api.redeemInvite(inviteId: inviteId) : try await model.api.redeemInvite(code: code.uppercased())
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
