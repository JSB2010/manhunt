import SwiftUI

struct CreateNightView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var title = "Manhunt night"
    @State private var date = Date()
    @State private var crews = CrewDraft.defaults(count: 2)
    @State private var myTeam: TeamKey = .A
    @State private var firstHider: TeamKey = .A
    @State private var seekMode: SeekMode = .TOGETHER
    @State private var rules = Rules.defaults
    @State private var groups: [GroupsResponse.Group] = []
    @State private var groupId: String?
    @State private var busy = false
    @State private var error: String?

    private var groupPeople: [Person] { groups.first(where: { $0.id == groupId })?.people ?? [] }
    private var selfPersonId: String? { model.me?.profile.selfPersonId }
    private func name(_ k: TeamKey) -> String { crews.first { $0.key == k }?.name ?? "Crew \(k.rawValue)" }

    var body: some View {
        NavigationStack {
            Form {
                Section("Night") {
                    TextField("Title", text: $title)
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    if !groups.isEmpty {
                        Picker("Saved group", selection: $groupId) {
                            Text("None").tag(String?.none)
                            ForEach(groups) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
                CrewsEditor(crews: $crews, phonePersonIds: Set([selfPersonId].compactMap { $0 }), groupPeople: groupPeople) { followSelf() }
                Section("Round 1") {
                    Picker("My phone’s crew", selection: $myTeam) {
                        ForEach(crews) { Text($0.name).tag($0.key) }
                    }
                    .onChange(of: myTeam) { _, _ in placeSelf() }
                    Picker("Hides first", selection: $firstHider) {
                        ForEach(crews) { Text($0.name).tag($0.key) }
                    }
                    if crews.count > 2 {
                        Picker("Seeking crews", selection: $seekMode) {
                            ForEach(SeekMode.allCases) { Text($0.label).tag($0) }
                        }
                    }
                }
                RulesEditor(rules: $rules)
            }
            .navigationTitle("Create a Night")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Create", busy: busy) { create() }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || crews.contains { $0.name.trimmingCharacters(in: .whitespaces).isEmpty })
                        .accessibilityIdentifier("create.submit")
                }
            }
            .onChange(of: crews.count) { _, _ in
                if !crews.contains(where: { $0.key == myTeam }) { myTeam = .A; placeSelf() }
                if !crews.contains(where: { $0.key == firstHider }) { firstHider = .A }
            }
            .task {
                #if DEBUG
                // UI-test hook (DEBUG only): shortest legal timings for automated two-phone runs.
                if ProcessInfo.processInfo.arguments.contains("-uiTestShortRules") {
                    rules.headStartSeconds = 60
                    rules.pingIntervalSeconds = 60
                    title = "UI test night"
                }
                #endif
                placeSelf()
                groups = (try? await model.api.groups().groups) ?? []
            }
            .errorAlert($error)
        }
    }

    /// The creator's own name sits on the crew their phone joins.
    private func placeSelf() {
        guard let me = model.me else { return }
        let entry = RosterEntryBody(personId: me.profile.selfPersonId, displayName: me.profile.displayName)
        for i in crews.indices { crews[i].roster.removeAll { $0.personId == entry.personId } }
        if let i = crews.firstIndex(where: { $0.key == myTeam }) { crews[i].roster.insert(entry, at: 0) }
    }

    /// After a shuffle, the phone goes where its owner was dealt.
    private func followSelf() {
        guard let selfPersonId, let crew = crews.first(where: { $0.roster.contains { $0.personId == selfPersonId } }) else { return }
        myTeam = crew.key
    }

    private func create() {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        let body = CreateSessionBody(
            title: title,
            scheduledDate: f.string(from: date),
            myTeam: myTeam,
            teams: Dictionary(uniqueKeysWithValues: crews.map { ($0.key.rawValue, TeamInputBody(name: $0.name, roster: $0.roster)) }),
            firstHidingTeam: firstHider,
            seekMode: crews.count > 2 ? seekMode : nil,
            rules: RulesPatch(rules),
            groupId: groupId)
        perform($busy, $error) {
            let view = try await model.api.createSession(body)
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
