import Foundation
import CoreLocation

/// This phone's own trail for one round, as the game map draws it.
///
/// It belongs to a round: a new round starts an empty trail, so the map never joins where the
/// last round ended to where the next one starts (Ready sets the next round's context before it
/// starts, so the round id is the only safe signal). Fixes more than `maxGapSeconds` apart start
/// a new segment, as the recap's routes do (`geo.ts`): a gap is a gap, not a straight line.
struct OwnTrail: Sendable {
    struct Point: Sendable {
        var coordinate: CLLocationCoordinate2D
        var at: Date
    }

    static let maxGapSeconds: TimeInterval = 120
    static let maxPoints = 4000

    private(set) var roundId: String?
    private(set) var points: [Point] = []
    /// Where this phone's trail began this round (kept when old points are trimmed).
    var start: CLLocationCoordinate2D? { first?.coordinate }
    private var first: Point?

    init(roundId: String? = nil) { self.roundId = roundId }

    var isEmpty: Bool { points.isEmpty }

    /// The trail to keep drawing for `roundId`: this one if it is that round's, else a new, empty one.
    func continuing(_ roundId: String) -> OwnTrail { self.roundId == roundId ? self : OwnTrail(roundId: roundId) }

    /// Runs of fixes without a gap longer than `maxGapSeconds`.
    var segments: [[CLLocationCoordinate2D]] {
        var out: [[CLLocationCoordinate2D]] = []
        var last: Date?
        for p in points {
            if let last, p.at.timeIntervalSince(last) <= Self.maxGapSeconds {
                out[out.count - 1].append(p.coordinate)
            } else {
                out.append([p.coordinate])
            }
            last = p.at
        }
        return out
    }

    mutating func append(_ coordinate: CLLocationCoordinate2D, at: Date) {
        merge([Point(coordinate: coordinate, at: at)])
    }

    /// Adds fixes in time order (a trail restored from the server can arrive after live fixes).
    mutating func merge(_ new: [Point]) {
        guard !new.isEmpty else { return }
        // A live fix is the newest; anything else (a restored trail) is sorted in.
        let inOrder = new.count == 1 && (points.last.map { new[0].at >= $0.at } ?? true)
        points += new
        if !inOrder { points.sort { $0.at < $1.at } }
        for p in new where first.map({ p.at < $0.at }) ?? true { first = p }
        if points.count > Self.maxPoints { points.removeFirst(points.count - Self.maxPoints) }
    }
}
