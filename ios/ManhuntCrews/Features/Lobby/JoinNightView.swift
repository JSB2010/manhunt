import SwiftUI

/// Join a night with its code (or a friend's direct invite) and pick a crew.
struct JoinNightView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var initialCode: String = ""
    var inviteId: String?
    @State private var code = ""
    @State private var preview: InvitePreview?
    @State private var crew: TeamKey?
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
                        Text("Night code")
                    }
                }
                if let p = preview {
                    Section(p.title) {
                        LabeledContent("Date", value: Fmt.day(p.scheduledDate))
                        if let host = p.hostDisplayName { LabeledContent("Organizer", value: host) }
                        LabeledContent("Head start", value: "\(p.rules.headStartSeconds / 60) min")
                        LabeledContent("Pings", value: "every \(p.rules.pingIntervalSeconds / 60) min")
                    }
                    Section("Your Crew") {
                        ForEach(p.teamKeys) { k in
                            if let t = p.teams[k.rawValue] { crewChoice(k, t) }
                        }
                    }
                }
            }
            .navigationTitle("Join a Night")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } } }
            .bottomActionBar {
                if preview != nil {
                    Button { join() } label: { ActionLabel(title: "Join \(preview.flatMap { p in crew.flatMap { p.teams[$0.rawValue]?.name } } ?? "Night")", systemImage: "person.badge.plus", busy: busy) }
                        .floatingProminentButton()
                        .controlSize(.large)
                        .disabled(busy || crew == nil)
                        .accessibilityIdentifier("join.submit")
                }
            }
            .onAppear {
                if code.isEmpty { code = initialCode }
                if inviteId != nil || !initialCode.isEmpty { lookup() }
            }
            .errorAlert($error)
        }
    }

    @ViewBuilder private func crewChoice(_ k: TeamKey, _ t: InvitePreview.TeamBrief) -> some View {
        Button { crew = k } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                CrewDot(key: k)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.name).foregroundStyle(.primary)
                    Text(t.roster.isEmpty ? phones(t.phoneCount) : "\(t.roster.map(\.displayName).formatted(.list(type: .and))) · \(phones(t.phoneCount))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if crew == k { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Selected") }
            }
        }
        .disabled(t.full)
        .accessibilityIdentifier("join.crew.\(k.rawValue)")
    }

    private func phones(_ n: Int) -> String { n == 1 ? "1 phone" : "\(n) phones" }

    private func lookup() {
        perform($busy, $error) {
            let p = inviteId != nil ? try await model.api.previewInvite(inviteId: inviteId) : try await model.api.previewInvite(code: code.uppercased())
            preview = p
            crew = p.myTeam ?? p.suggestedTeam
        }
    }

    private func join() {
        perform($busy, $error) {
            let view = inviteId != nil
                ? try await model.api.redeemInvite(inviteId: inviteId, teamKey: crew)
                : try await model.api.redeemInvite(code: code.uppercased(), teamKey: crew)
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
