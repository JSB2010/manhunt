import Foundation

/// The people of a night being set up or edited: two or three crews, and Sitting Out (ADR 0019).
/// Phones aren't placed here: the server puts every phone where its owner is.
struct CrewBoard: Equatable, Sendable {
    enum Place: Hashable, Sendable {
        case crew(TeamKey)
        case bench
    }

    struct Crew: Identifiable, Equatable, Sendable {
        var key: TeamKey
        var roster: [RosterEntryBody]
        var id: TeamKey { key }
    }

    var crews: [Crew]
    var bench: [RosterEntryBody] = []

    static func defaults(count: Int) -> CrewBoard {
        CrewBoard(crews: TeamKey.allCases.prefix(count).map { Crew(key: $0, roster: []) })
    }

    init(crews: [Crew], bench: [RosterEntryBody] = []) {
        self.crews = crews
        self.bench = bench
    }

    init(_ session: SessionHeader) {
        let entry = { (p: PersonRef) in RosterEntryBody(personId: p.personId, displayName: p.displayName) }
        crews = session.teamKeys.compactMap { k in session.team(k).map { Crew(key: k, roster: $0.roster.map(entry)) } }
        bench = session.bench.roster.map(entry)
    }

    /// A person's identity on the board: their person record (new names are saved as people first).
    static func id(_ e: RosterEntryBody) -> String { e.personId ?? "name:\(e.displayName)" }

    var keys: [TeamKey] { crews.map(\.key) }
    var everyone: [RosterEntryBody] { crews.flatMap(\.roster) + bench }

    func people(in place: Place) -> [RosterEntryBody] {
        switch place {
        case .bench: bench
        case .crew(let k): crews.first { $0.key == k }?.roster ?? []
        }
    }

    func place(of id: String) -> Place? {
        if let crew = crews.first(where: { $0.roster.contains { Self.id($0) == id } }) { return .crew(crew.key) }
        return bench.contains { Self.id($0) == id } ? .bench : nil
    }

    func entry(_ id: String) -> RosterEntryBody? { everyone.first { Self.id($0) == id } }

    /// Move someone to a crew or Sitting Out, before `before` (someone already there) or at the end.
    mutating func move(_ id: String, to place: Place, before: String? = nil) {
        guard let entry = entry(id), before != id else { return }
        detach(id)
        insert(entry, into: place, before: before)
    }

    /// Add a name; someone already in the night moves here instead of being listed twice.
    mutating func add(_ entry: RosterEntryBody, to place: Place) {
        if self.place(of: Self.id(entry)) != nil { move(Self.id(entry), to: place) } else { insert(entry, into: place, before: nil) }
    }

    /// Take someone out of the night (their phone leaves with them).
    mutating func remove(_ id: String) { detach(id) }

    /// Two or three crews. A dropped crew's people go to the smallest remaining crews.
    mutating func setCrewCount(_ n: Int) {
        if n > crews.count {
            for k in TeamKey.allCases.dropFirst(crews.count).prefix(n - crews.count) { crews.append(Crew(key: k, roster: [])) }
        } else if n < crews.count, n >= 1 {
            let dropped = crews.dropFirst(n).flatMap(\.roster)
            crews.removeLast(crews.count - n)
            for p in dropped {
                let i = crews.indices.min { crews[$0].roster.count < crews[$1].roster.count }!
                crews[i].roster.append(p)
            }
        }
    }

    /// Random, even crews from everyone on a crew (Sitting Out stays put); phone owners are dealt first.
    mutating func shuffle(isPhone: (RosterEntryBody) -> Bool, using rng: inout some RandomNumberGenerator) {
        let dealt = TeamShuffler.deal(crews.flatMap(\.roster), into: crews.count, isPhone: isPhone, using: &rng)
        for i in crews.indices { crews[i].roster = dealt[i] }
    }

    mutating func shuffle(isPhone: (RosterEntryBody) -> Bool) {
        var rng = SystemRandomNumberGenerator()
        shuffle(isPhone: isPhone, using: &rng)
    }

    /// The crew's name as the server will set it: its people.
    func label(_ key: TeamKey) -> String {
        CrewNames.label(people(in: .crew(key)), key, short: CrewNames.short(everyone))
    }

    private mutating func detach(_ id: String) {
        for i in crews.indices { crews[i].roster.removeAll { Self.id($0) == id } }
        bench.removeAll { Self.id($0) == id }
    }

    private mutating func insert(_ entry: RosterEntryBody, into place: Place, before: String?) {
        func put(_ list: inout [RosterEntryBody]) {
            if let before, let i = list.firstIndex(where: { Self.id($0) == before }) { list.insert(entry, at: i) } else { list.append(entry) }
        }
        switch place {
        case .bench: put(&bench)
        case .crew(let k):
            guard let i = crews.firstIndex(where: { $0.key == k }) else { return }
            put(&crews[i].roster)
        }
    }
}

/// Crew names from their people, the same way the server names them (`crews.crewLabel`, ADR 0019):
/// "Sasha", "Sasha & Marco", "Sasha, Marco & Theo", "Sasha, Marco & 3 more"; an empty crew is its colour.
enum CrewNames {
    /// First names; a last initial where two people share a first name, or the full name when that is shared too.
    static func short(_ people: [RosterEntryBody]) -> [String: String] {
        let words = { (e: RosterEntryBody) in e.displayName.split(whereSeparator: \.isWhitespace).map(String.init) }
        var groups: [String: [RosterEntryBody]] = [:]
        var order: [String] = []
        for p in people {
            let first = (words(p).first ?? p.displayName).lowercased()
            if groups[first] == nil { order.append(first) }
            groups[first, default: []].append(p)
        }
        var out: [String: String] = [:]
        for key in order {
            let group = groups[key]!
            let initials = { (p: RosterEntryBody) -> String in
                let w = words(p)
                guard w.count > 1, let last = w.last?.first else { return w.first ?? p.displayName }
                return "\(w[0]) \(last.uppercased())."
            }
            let distinct = group.count == 1 || Set(group.map { initials($0).lowercased() }).count == group.count
            for p in group {
                let w = words(p)
                out[CrewBoard.id(p)] = group.count == 1 ? (w.first ?? p.displayName) : distinct ? initials(p) : p.displayName.trimmingCharacters(in: .whitespaces)
            }
        }
        return out
    }

    /// The crew's name already lists everyone in full ("Morgan & Taylor"), so a list of its people would repeat it.
    /// False for a typed name from before ADR 0019 ("Owls"), or when the name shortened or left someone out.
    static func nameListsEveryone(_ name: String, people: [PersonRef], key: TeamKey) -> Bool {
        let entries = people.map { RosterEntryBody(personId: $0.personId, displayName: $0.displayName) }
        return !people.isEmpty && people.count <= 3 && !people.contains { $0.displayName.trimmingCharacters(in: .whitespaces).contains(" ") }
            && label(entries, key) == name
    }

    static func label(_ roster: [RosterEntryBody], _ key: TeamKey, short: [String: String]? = nil) -> String {
        let short = short ?? Self.short(roster)
        let names = roster.map { short[CrewBoard.id($0)] ?? $0.displayName }
        switch names.count {
        case 0: return key.colourName
        case 1: return names[0]
        case 2, 3: return "\(names.dropLast().joined(separator: ", ")) & \(names.last!)"
        default: return "\(names.prefix(2).joined(separator: ", ")) & \(names.count - 2) more"
        }
    }
}
