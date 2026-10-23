import SwiftUI

/// Between rounds (or before the first): crews, their people and phones, and the rules.
/// Any phone on a crew can edit. A READY round picks up the changes.
struct EditNightSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let view: SessionViewDoc

    @State private var title = ""
    @State private var crews: [CrewDraft] = []
    /// phone uid → crew it will be on (nil = removed from the night)
    @State private var phoneCrew: [String: TeamKey?] = [:]
    @State private var rules = Rules.defaults
    @State private var busy = false
    @State private var error: String?

    private var phones: [OperatorView] { view.session.teamKeys.flatMap { view.session.team($0)?.operators ?? [] } }
    private var currentCrew: [String: TeamKey] {
        Dictionary(uniqueKeysWithValues: view.session.teamKeys.flatMap { k in (view.session.team(k)?.operators ?? []).map { ($0.uid, k) } })
    }
    private var phonePersonIds: Set<String> { Set(phones.compactMap(\.personId)) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Night") { TextField("Title", text: $title) }
                CrewsEditor(crews: $crews, phonePersonIds: phonePersonIds) { followPeople() }
                Section {
                    ForEach(phones, id: \.uid) { phone in
                        Picker(selection: binding(phone.uid)) {
                            ForEach(crews) { Text($0.name).tag(Optional($0.key)) }
                            if !phone.isMe && phone.uid != hostUid { Text("Remove").tag(TeamKey?.none) }
                        } label: {
                            Label(phone.isMe ? "\(phone.displayName) (you)" : phone.displayName, systemImage: "iphone")
                        }
                    }
                } header: {
                    Text("Phones")
                } footer: {
                    Text("Every crew needs at least one phone to play. A phone’s owner moves with it.")
                }
                RulesEditor(rules: $rules)
            }
            .navigationTitle("Crews & Rules")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Save", busy: busy) { save() }
                        .disabled(crews.contains { $0.name.trimmingCharacters(in: .whitespaces).isEmpty })
                }
            }
            .onChange(of: crews.map(\.key)) { _, keys in
                // A dropped crew's phones go to the crew with the fewest phones.
                for (uid, k) in phoneCrew where k.map({ !keys.contains($0) }) ?? false {
                    phoneCrew[uid] = keys.min { phoneCount($0) < phoneCount($1) }
                }
            }
            .onAppear(perform: load)
            .errorAlert($error)
        }
    }

    /// The organizer's phone can't be removed (only they can delete the night).
    private var hostUid: String? { view.session.isHost ? phones.first(where: \.isMe)?.uid : nil }

    private func phoneCount(_ k: TeamKey) -> Int { phoneCrew.values.filter { $0 == k }.count }

    private func binding(_ uid: String) -> Binding<TeamKey?> {
        Binding(get: { phoneCrew[uid] ?? nil }, set: { k in
            phoneCrew[uid] = k
            if let k { followPhone(uid, to: k) }
        })
    }

    /// A moved phone takes its owner's name to the new crew (the server does the same, ADR 0018):
    /// rounds are credited to the names on each crew.
    private func followPhone(_ uid: String, to k: TeamKey) {
        guard let pid = phones.first(where: { $0.uid == uid })?.personId,
              let from = crews.firstIndex(where: { $0.roster.contains { $0.personId == pid } }),
              let to = crews.firstIndex(where: { $0.key == k }), from != to,
              let entry = crews[from].roster.first(where: { $0.personId == pid }) else { return }
        crews[from].roster.removeAll { $0.personId == pid }
        crews[to].roster.append(entry)
    }

    private func load() {
        title = view.session.title
        crews = view.session.teamKeys.compactMap { view.session.team($0).map(CrewDraft.init) }
        phoneCrew = currentCrew.mapValues { Optional($0) }
        rules = view.session.rules
    }

    /// After a shuffle, each phone follows its owner to their new crew.
    private func followPeople() {
        for phone in phones {
            guard let pid = phone.personId, let crew = crews.first(where: { $0.roster.contains { $0.personId == pid } }) else { continue }
            phoneCrew[phone.uid] = crew.key
        }
    }

    private func save() {
        var teams: [String: SetupPatchBody.CrewEdit] = [:]
        for c in crews { teams[c.key.rawValue] = .edit(.init(name: c.name, roster: c.roster)) }
        for k in view.session.teamKeys where !crews.contains(where: { $0.key == k }) { teams[k.rawValue] = .remove }
        let moves = phones.compactMap { phone -> SetupPatchBody.Move? in
            let target = phoneCrew[phone.uid] ?? nil
            return target == currentCrew[phone.uid] ? nil : .init(uid: phone.uid, teamKey: target)
        }
        perform($busy, $error) {
            try await model.api.editSetup(view.sessionId, SetupPatchBody(title: title, rules: RulesPatch(rules), teams: teams, moves: moves.isEmpty ? nil : moves))
            dismiss()
        }
    }
}
