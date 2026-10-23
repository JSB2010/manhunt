import SwiftUI

struct CreateNightView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var title = "Manhunt night"
    @State private var date = Date()
    @State private var board = CrewBoard.defaults(count: 2)
    @State private var firstHider: TeamKey = .A
    @State private var seekMode: SeekMode = .TOGETHER
    @State private var rules = Rules.defaults
    @State private var groups: [GroupsResponse.Group] = []
    @State private var groupId: String?
    @State private var busy = false
    @State private var error: String?

    private var groupPeople: [Person] { groups.first(where: { $0.id == groupId })?.people ?? [] }
    private var selfPersonId: String? { model.me?.profile.selfPersonId }
    /// My phone plays on the crew I'm on (I can't sit out the night I create).
    private var myTeam: TeamKey {
        if let selfPersonId, case .crew(let k)? = board.place(of: selfPersonId) { return k }
        return board.keys.first ?? .A
    }

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
                PeopleBoard(board: $board, mustPlay: Set([selfPersonId].compactMap { $0 }), groupPeople: groupPeople)
                Section("Round 1") {
                    Picker("Hides first", selection: $firstHider) {
                        ForEach(board.keys) { Text(board.label($0)).tag($0) }
                    }
                    .accessibilityIdentifier("create.firstHider")
                    if board.crews.count > 2 {
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
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("create.submit")
                }
            }
            .onChange(of: board.crews.count) { _, _ in
                if !board.keys.contains(firstHider) { firstHider = .A }
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

    /// The creator starts on the first crew; their phone goes wherever they're moved.
    private func placeSelf() {
        guard let me = model.me, board.place(of: me.profile.selfPersonId) == nil, !board.crews.isEmpty else { return }
        board.crews[0].roster.insert(RosterEntryBody(personId: me.profile.selfPersonId, displayName: me.profile.displayName), at: 0)
    }

    private func create() {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        let body = CreateSessionBody(
            title: title,
            scheduledDate: f.string(from: date),
            myTeam: myTeam,
            teams: Dictionary(uniqueKeysWithValues: board.crews.map { ($0.key.rawValue, TeamInputBody(roster: $0.roster)) }),
            bench: board.bench.isEmpty ? nil : board.bench,
            firstHidingTeam: firstHider,
            seekMode: board.crews.count > 2 ? seekMode : nil,
            rules: RulesPatch(rules),
            groupId: groupId)
        perform($busy, $error) {
            let view = try await model.api.createSession(body)
            dismiss()
            model.openSession(view.sessionId)
        }
    }
}
