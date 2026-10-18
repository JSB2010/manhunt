import Foundation
import CoreLocation

/// Client-side cadence filter (spec §5.2): roughly every 5–15 s or 10–25 m
/// while moving, ~30 s while stationary. The 10-minute ping interval is NOT the
/// recording interval. Server-side filters re-check quality independently.
struct SampleFilter: Sendable {
    var minInterval: TimeInterval = 5
    var moveThresholdMeters: CLLocationDistance = 10
    var movingMaxInterval: TimeInterval = 15
    var stationaryInterval: TimeInterval = 30
    var maxAcceptableAccuracy: CLLocationAccuracy = 200

    private(set) var last: (date: Date, coordinate: CLLocationCoordinate2D)?

    /// Decide whether a fix should be recorded.
    mutating func shouldKeep(timestamp: Date, coordinate: CLLocationCoordinate2D, horizontalAccuracy: CLLocationAccuracy, stationary: Bool) -> Bool {
        guard horizontalAccuracy >= 0, horizontalAccuracy <= maxAcceptableAccuracy, CLLocationCoordinate2DIsValid(coordinate) else { return false }
        guard let last else {
            self.last = (timestamp, coordinate)
            return true
        }
        let dt = timestamp.timeIntervalSince(last.date)
        if dt < 0 { return false } // out-of-order / duplicate delivery
        if dt < minInterval { return false }
        let moved = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
            .distance(from: CLLocation(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude))
        let keep = stationary ? dt >= stationaryInterval : (moved >= moveThresholdMeters || dt >= movingMaxInterval)
        if keep { self.last = (timestamp, coordinate) }
        return keep
    }

    mutating func reset() { last = nil }
}
