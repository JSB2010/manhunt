import Foundation

/// Random, balanced teams. Phone owners are dealt first, one per crew in turn,
/// so every crew gets a tracking phone whenever there are enough phones; then
/// everyone else fills the smallest crews. Re-running gives a new draw.
enum TeamShuffler {
    static func deal<T>(_ people: [T], into count: Int, isPhone: (T) -> Bool, using rng: inout some RandomNumberGenerator) -> [[T]] {
        guard count > 0 else { return [] }
        var crews = Array(repeating: [T](), count: count)
        let phones = people.filter(isPhone).shuffled(using: &rng)
        let others = people.filter { !isPhone($0) }.shuffled(using: &rng)
        // Phones round-robin from a random starting crew, so crew A isn't always the one with an extra phone.
        let start = Int.random(in: 0..<count, using: &rng)
        for (i, p) in phones.enumerated() { crews[(start + i) % count].append(p) }
        for p in others {
            let smallest = crews.indices.min { crews[$0].count < crews[$1].count || (crews[$0].count == crews[$1].count && $0 < $1) }!
            crews[smallest].append(p)
        }
        return crews
    }

    static func deal<T>(_ people: [T], into count: Int, isPhone: (T) -> Bool) -> [[T]] {
        var rng = SystemRandomNumberGenerator()
        return deal(people, into: count, isPhone: isPhone, using: &rng)
    }
}
