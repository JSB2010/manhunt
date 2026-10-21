import SwiftUI

/// A crew being set up: its name and roster (people on a roster don't need the app).
struct CrewDraft: Identifiable, Equatable, Sendable {
    var key: TeamKey
    var name: String
    var roster: [RosterEntryBody]
    var id: TeamKey { key }

    static func defaults(count: Int) -> [CrewDraft] {
        TeamKey.allCases.prefix(count).map { CrewDraft(key: $0, name: "Crew \($0.rawValue)", roster: []) }
    }

    init(key: TeamKey, name: String, roster: [RosterEntryBody]) {
        self.key = key
        self.name = name
        self.roster = roster
    }

    init(_ team: TeamView) {
        self.init(key: team.key, name: team.name, roster: team.roster.map { .init(personId: $0.personId, displayName: $0.displayName) })
    }
}

/// Two or three crews: names, rosters, and Shuffle for random, even teams.
struct CrewsEditor: View {
    @Binding var crews: [CrewDraft]
    /// Roster people who carry a tracking phone — dealt first so each crew gets one.
    var phonePersonIds: Set<String> = []
    var groupPeople: [Person] = []
    /// Called after a shuffle so the caller can follow phones to their new crews.
    var onShuffle: () -> Void = {}

    private var everyone: [RosterEntryBody] { crews.flatMap(\.roster) }

    var body: some View {
        Section {
            Picker("Crews", selection: count) {
                Text("2 Crews").tag(2)
                Text("3 Crews").tag(3)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("crews.count")
            ForEach($crews) { $crew in
                Label { TextField("Crew \(crew.key.rawValue) name", text: $crew.name) } icon: { CrewDot(key: crew.key) }
            }
            Button { shuffle() } label: { Label("Shuffle Teams", systemImage: "shuffle") }
                .disabled(everyone.count < crews.count)
                .accessibilityIdentifier("crews.shuffle")
        } header: {
            Text("Crews")
        } footer: {
            Text("Add everyone, then Shuffle for random, even crews.")
        }
        ForEach($crews) { $crew in
            RosterEditor(title: crew.name.isEmpty ? "Crew \(crew.key.rawValue)" : crew.name, roster: $crew.roster, excluded: personIds(except: crew.key), groupPeople: groupPeople)
        }
    }

    private var count: Binding<Int> {
        Binding(get: { crews.count }, set: { n in
            if n > crews.count {
                for k in TeamKey.allCases.dropFirst(crews.count).prefix(n - crews.count) { crews.append(CrewDraft(key: k, name: "Crew \(k.rawValue)", roster: [])) }
            } else {
                // Fold the dropped crew's people into the smallest remaining crews.
                let dropped = crews.dropFirst(n).flatMap(\.roster)
                crews.removeLast(crews.count - n)
                for p in dropped {
                    let i = crews.indices.min { crews[$0].roster.count < crews[$1].roster.count }!
                    crews[i].roster.append(p)
                }
            }
        })
    }

    private func personIds(except key: TeamKey) -> Set<String> {
        Set(crews.filter { $0.key != key }.flatMap { $0.roster.compactMap(\.personId) })
    }

    private func shuffle() {
        let dealt = TeamShuffler.deal(everyone, into: crews.count) { $0.personId.map(phonePersonIds.contains) ?? false }
        for i in crews.indices { crews[i].roster = dealt[i] }
        onShuffle()
    }
}
