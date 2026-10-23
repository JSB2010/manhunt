import SwiftUI

/// Between rounds (or before the first): who is on which crew, who sits out, and the rules.
/// Any phone in the night can edit. Every phone follows its owner; a READY round picks up the changes.
struct EditNightSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let view: SessionViewDoc

    @State private var title = ""
    @State private var board = CrewBoard.defaults(count: 2)
    /// Phones to take out of the night on save; their owners keep playing without them.
    @State private var phonesOut: Set<String> = []
    /// Phones with no name linked (nights from before names followed phones): uid → crew, nil = out.
    @State private var unlinkedCrew: [String: TeamKey?] = [:]
    @State private var rules = Rules.defaults
    @State private var busy = false
    @State private var error: String?

    private var session: SessionHeader { view.session }
    private var allPhones: [OperatorView] { session.teamKeys.flatMap { session.team($0)?.operators ?? [] } + session.bench.operators }
    /// Phones by their owner's person id.
    private var phones: [String: OperatorView] {
        Dictionary(allPhones.compactMap { op in op.personId.map { ($0, op) } }, uniquingKeysWith: { a, _ in a })
    }
    private var unlinked: [OperatorView] { allPhones.filter { $0.personId == nil } }
    /// This phone's owner can't remove themselves here (the organizer can't be removed at all).
    private var mine: Set<String> { Set(allPhones.filter(\.isMe).compactMap(\.personId)) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Night") { TextField("Title", text: $title) }
                PeopleBoard(board: $board, phones: phones, cannotLeave: mine, phonesOut: $phonesOut)
                if !unlinked.isEmpty { unlinkedSection }
                RulesEditor(rules: $rules)
            }
            .navigationTitle("Crews & Rules")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Save", busy: busy) { save() }
                        .accessibilityIdentifier("edit.save")
                }
            }
            .onAppear(perform: load)
            .errorAlert($error)
        }
    }

    /// Phones the night has no name for: they can still be moved or taken out.
    private var unlinkedSection: some View {
        Section {
            ForEach(unlinked, id: \.uid) { phone in
                Picker(selection: Binding(get: { unlinkedCrew[phone.uid] ?? nil }, set: { unlinkedCrew[phone.uid] = $0 })) {
                    ForEach(board.keys) { Text($0.colourName).tag(Optional($0)) }
                    if !phone.isMe { Text("Take Out").tag(TeamKey?.none) }
                } label: {
                    Label(phone.isMe ? "\(phone.displayName) (you)" : phone.displayName, systemImage: "iphone")
                }
            }
        } header: {
            Text("Phones Without a Name")
        } footer: {
            Text("Saving lists each of these phones’ owners on its crew.")
        }
    }

    private func load() {
        title = session.title
        board = CrewBoard(session)
        rules = session.rules
        for k in session.teamKeys { for op in session.team(k)?.operators ?? [] where op.personId == nil { unlinkedCrew[op.uid] = k } }
    }

    private func save() {
        var teams: [String: SetupPatchBody.CrewEdit] = [:]
        for c in board.crews { teams[c.key.rawValue] = .edit(.init(roster: c.roster)) }
        for k in session.teamKeys where !board.keys.contains(k) { teams[k.rawValue] = .remove }
        var moves = phonesOut.sorted().map { SetupPatchBody.Move(uid: $0, teamKey: nil) }
        for phone in unlinked {
            let target = unlinkedCrew[phone.uid] ?? nil
            if target != session.teamKeys.first(where: { session.team($0)?.operators.contains { $0.uid == phone.uid } ?? false }) {
                moves.append(.init(uid: phone.uid, teamKey: target))
            }
        }
        perform($busy, $error) {
            try await model.api.editSetup(view.sessionId, SetupPatchBody(title: title, rules: RulesPatch(rules), teams: teams, bench: board.bench, moves: moves.isEmpty ? nil : moves))
            dismiss()
        }
    }
}
