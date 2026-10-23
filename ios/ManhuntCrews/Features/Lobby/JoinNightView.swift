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
    /// The roster name this phone's owner plays as; nil = not listed (their own name is added).
    @State private var me: String?
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
                    if !names(p).isEmpty {
                        Section {
                            Picker("You are", selection: $me) {
                                ForEach(names(p), id: \.personId) { Text($0.displayName).tag(Optional($0.personId)) }
                                Text("Not listed — add me").tag(String?.none)
                            }
                            .accessibilityIdentifier("join.me")
                        } header: {
                            Text("Who Are You?")
                        } footer: {
                            Text("Pick the name the organizer typed for you, so your rounds count for you and you’re not listed twice.")
                        }
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
            // You play on your phone's crew: picking your name picks the crew it's on (still changeable).
            .onChange(of: me) { _, id in
                if let id, let p = preview, let k = p.crew(of: id) { crew = k }
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
            me = p.suggestedPersonId
            crew = p.myTeam ?? me.flatMap(p.crew(of:)) ?? p.suggestedTeam
        }
    }

    /// Roster names nobody else's phone plays as yet.
    private func names(_ p: InvitePreview) -> [PersonRef] {
        let claimed = Set(p.claimedPersonIds ?? [])
        return p.teamKeys.flatMap { p.teams[$0.rawValue]?.roster ?? [] }.filter { !claimed.contains($0.personId) }
    }

    private func join() {
        perform($busy, $error) {
            let view = inviteId != nil
                ? try await model.api.redeemInvite(inviteId: inviteId, teamKey: crew, personId: me)
                : try await model.api.redeemInvite(code: code.uppercased(), teamKey: crew, personId: me)
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
