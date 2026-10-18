import SwiftUI

struct CreateNightView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var title = "Manhunt night"
    @State private var date = Date()
    @State private var nameA = "Crew A"
    @State private var nameB = "Crew B"
    @State private var myTeam: TeamKey = .A
    @State private var rosterA: [RosterEntryBody] = []
    @State private var rosterB: [RosterEntryBody] = []
    @State private var rules = Rules.defaults
    @State private var groups: [GroupsResponse.Group] = []
    @State private var groupId: String?
    @State private var acknowledged = false
    @State private var busy = false
    @State private var error: String?

    private var groupPeople: [Person] { groups.first(where: { $0.id == groupId })?.people ?? [] }

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
                Section {
                    TextField("Crew A name", text: $nameA)
                    TextField("Crew B name", text: $nameB)
                    Picker("My phone operates", selection: $myTeam) {
                        Text(nameA).tag(TeamKey.A)
                        Text(nameB).tag(TeamKey.B)
                    }
                    .onChange(of: myTeam) { _, _ in placeSelf() }
                } header: {
                    Text("Crews")
                } footer: {
                    Text("You'll invite the other crew's operator next. Exactly two tracking iPhones: one per crew.")
                }
                RosterEditor(title: "\(nameA) roster", roster: $rosterA, excluded: Set(rosterB.compactMap(\.personId)), groupPeople: groupPeople)
                RosterEditor(title: "\(nameB) roster", roster: $rosterB, excluded: Set(rosterA.compactMap(\.personId)), groupPeople: groupPeople)
                RulesEditor(rules: $rules, teamNames: (nameA, nameB))
                Section {
                    Toggle(isOn: $acknowledged) {
                        Text("I'll tell my crew that my phone's route, our roster and catch photos are recorded, released to the other crew as scheduled pings during play, and shown to both operators after each round.")
                            .font(.callout)
                    }
                    .accessibilityIdentifier("create.ack")
                } header: {
                    Text("Disclosure")
                }
            }
            .navigationTitle("Create night")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { create() } label: { if busy { ProgressView() } else { Text("Create").bold() } }
                        .disabled(!acknowledged || busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("create.submit")
                }
            }
            .task {
                #if DEBUG
                // UI-test hook (DEBUG only): shortest legal timings for automated two-phone runs.
                if ProcessInfo.processInfo.arguments.contains("-uiTestShortRules") {
                    rules.headStartSeconds = 60
                    rules.pingIntervalSeconds = 60
                    rules.totalRounds = 2
                    title = "UI test night"
                }
                #endif
                placeSelf()
                groups = (try? await model.api.groups().groups) ?? []
            }
            .errorAlert($error)
        }
    }

    private func placeSelf() {
        guard let me = model.me else { return }
        let selfEntry = RosterEntryBody(personId: me.profile.selfPersonId, displayName: me.profile.displayName)
        rosterA.removeAll { $0.personId == selfEntry.personId }
        rosterB.removeAll { $0.personId == selfEntry.personId }
        if myTeam == .A { rosterA.insert(selfEntry, at: 0) } else { rosterB.insert(selfEntry, at: 0) }
    }

    private func create() {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        let body = CreateSessionBody(
            title: title,
            scheduledDate: f.string(from: date),
            myTeam: myTeam,
            teams: ["A": .init(name: nameA, roster: rosterA), "B": .init(name: nameB, roster: rosterB)],
            rules: RulesPatch(rules),
            groupId: groupId)
        perform($busy, $error) {
            let view = try await model.api.createSession(body)
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
