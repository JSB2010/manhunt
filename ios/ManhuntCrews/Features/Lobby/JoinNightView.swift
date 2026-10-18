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
                            .font(.title2.monospaced())
                        Button("Look up") { lookup() }.disabled(code.count < 6 || busy)
                    } header: {
                        Text("Invite code")
                    } footer: {
                        Text("Ask the host for the code shown in their lobby. Codes expire.")
                    }
                }
                if let p = preview {
                    Section(p.title) {
                        LabeledContent("Date", value: p.scheduledDate)
                        LabeledContent("Host", value: p.hostDisplayName ?? "—")
                        LabeledContent("You will operate", value: p.teams[p.teamKey.rawValue]?.name ?? p.teamKey.rawValue)
                        if let roster = p.teams[p.teamKey.rawValue]?.roster, !roster.isEmpty {
                            Text("Crew: " + roster.map(\.displayName).joined(separator: ", ")).font(.callout)
                        }
                        LabeledContent("Head start", value: "\(p.rules.headStartSeconds / 60) min")
                        LabeledContent("Pings", value: "every \(p.rules.pingIntervalSeconds / 60) min")
                        LabeledContent("Rounds", value: "\(p.rules.totalRounds)")
                    }
                }
                if preview != nil || inviteId != nil {
                    Section {
                        BigButton(title: "Join as operator", systemImage: "person.badge.plus", busy: busy) { join() }
                    } footer: {
                        Text("Next you'll review the tracking disclosure before any location is recorded.")
                    }
                }
            }
            .navigationTitle("Join night")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
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
