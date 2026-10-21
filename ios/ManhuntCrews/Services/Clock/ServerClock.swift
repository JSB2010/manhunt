import Foundation

/// Server-authoritative clock (spec §10.3). Every API response carries the
/// server time; we anchor it to a monotonic clock so changing the phone's wall
/// clock cannot change any displayed game timer. The clock keeps counting while
/// the device sleeps (a phone locked in a pocket mid-round): uptime-based clocks
/// stop then, and every timer would lag by the time asleep after waking.
final class ServerClock: @unchecked Sendable {
    /// Seconds on a monotonic clock that includes sleep and ignores wall-clock changes.
    static func continuousSeconds() -> TimeInterval { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000 }

    static let shared = ServerClock()

    private let elapsed: () -> TimeInterval
    private let lock = NSLock()
    private var anchorServer: Date?
    private var anchorUptime: TimeInterval = 0
    private var bestRtt: TimeInterval = .infinity
    private(set) var lastSyncAt: Date?

    init(elapsed: @escaping () -> TimeInterval = ServerClock.continuousSeconds) { self.elapsed = elapsed }

    /// Feed a server timestamp observed in a response. `rtt` is the request round trip.
    func observe(serverTime: Date, rtt: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        let uptime = elapsed()
        // Prefer low-latency samples; always accept if the anchor is old.
        let stale = anchorServer == nil || uptime - anchorUptime > 120
        guard stale || rtt <= bestRtt * 1.5 else { return }
        bestRtt = min(bestRtt, rtt)
        anchorServer = serverTime.addingTimeInterval(rtt / 2)
        anchorUptime = uptime
        lastSyncAt = Date()
    }

    var isSynced: Bool {
        lock.lock(); defer { lock.unlock() }
        return anchorServer != nil
    }

    /// Best estimate of server "now".
    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        guard let anchorServer else { return Date() }
        return anchorServer.addingTimeInterval(elapsed() - anchorUptime)
    }

    /// Convert a server timestamp to the local wall clock (for scheduling local notifications).
    func localDate(forServer date: Date) -> Date {
        Date().addingTimeInterval(date.timeIntervalSince(now()))
    }

    /// Offset of the device clock relative to the server (+ = device ahead).
    var deviceOffsetSeconds: TimeInterval { Date().timeIntervalSince(now()) }
}
