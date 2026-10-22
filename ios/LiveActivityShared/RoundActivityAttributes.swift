import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

// Shared by the app and the ManhuntCrewsWidgets extension (ADR 0017).
//
// Mirrors backend/src/domain/views.ts (`LiveActivityAttributes`, `LiveActivityState`,
// `liveActivityStaleDate`). ActivityKit decodes server pushes into these types with
// the default JSON strategies, so property names are the wire keys and times are plain
// epoch seconds (not `Date`, whose default Codable form counts from 2001).
// shared/fixtures/live-activity.json pins the mapping on both sides.

/// One round on the Lock Screen, in the Dynamic Island, the Smart Stack and CarPlay.
/// Content is what the phone's own view shows — never a location.
struct RoundActivityAttributes: Codable, Hashable, Sendable {
    enum Role: String, Codable, Hashable, Sendable { case HIDING, SEEKING }
    enum Phase: String, Codable, Hashable, Sendable { case HEAD_START, CHASE, CAPTURE_PENDING, PAUSED, ENDED }
    enum Outcome: String, Codable, Hashable, Sendable { case CAUGHT, TIMED_OUT, ABORTED }

    struct LastPing: Codable, Hashable, Sendable {
        var index: Int
        /// epoch seconds (phone clock)
        var at: Double
        /// the slot passed without a fresh hider fix
        var missing: Bool
    }

    struct Claim: Codable, Hashable, Sendable {
        /// "A" | "B" | "C"
        var crew: String
        var expiresAt: Double?
    }

    struct Result: Codable, Hashable, Sendable {
        var result: Outcome
        /// crews credited with the catch (attribution only — no individual times)
        var creditCrews: [String]
    }

    struct ContentState: Codable, Hashable, Sendable {
        var phase: Phase
        /// while paused: the phase the clocks froze in
        var pausedPhase: Phase?
        var safetyPause: Bool
        /// head start running: countdown target (epoch seconds, phone clock)
        var headStartEndsAt: Double?
        /// head start frozen: seconds left
        var headStartRemaining: Double?
        /// chase clock running: it reads now − chaseStartedAt
        var chaseStartedAt: Double?
        /// chase clock frozen (claim review, pause, end): seconds
        var chaseElapsed: Double?
        var nextPingAt: Double?
        var nextPingIndex: Int
        var timeCapAt: Double?
        var lastPing: LastPing?
        var pingWaiting: Bool
        var claim: Claim?
        var outcome: Result?
    }

    var sessionId: String
    var roundId: String
    var roundIndex: Int
    var role: Role
    /// "A" | "B" | "C"
    var crew: String
    var crewName: String
}

#if canImport(ActivityKit)
extension RoundActivityAttributes: ActivityAttributes {}
#endif

extension RoundActivityAttributes.ContentState {
    /// Mirrors `LIVE_ACTIVITY_STALE_GRACE_S` in views.ts.
    static let staleGrace: TimeInterval = 90

    /// When the content goes out of date: the next expected update plus a grace period.
    /// Nil while nothing is due (paused, waiting ping, ended). Mirrors `liveActivityStaleDate`.
    var staleDate: Double? {
        let due: [Double?] = switch phase {
        case .HEAD_START: [headStartEndsAt]
        case .CHASE: pingWaiting ? [] : [nextPingAt, timeCapAt]
        case .CAPTURE_PENDING: [claim?.expiresAt]
        case .PAUSED, .ENDED: []
        }
        return due.compactMap { $0 }.min().map { $0 + Self.staleGrace }
    }

    static func date(_ epochSeconds: Double?) -> Date? { epochSeconds.map(Date.init(timeIntervalSince1970:)) }

    var headStartEnd: Date? { Self.date(headStartEndsAt) }
    var chaseStart: Date? { Self.date(chaseStartedAt) }
    var nextPing: Date? { Self.date(nextPingAt) }
    var claimExpiry: Date? { Self.date(claim?.expiresAt) }
    var lastPingDate: Date? { Self.date(lastPing?.at) }
    /// The phase the clocks show (the frozen one while paused).
    var clockPhase: RoundActivityAttributes.Phase { phase == .PAUSED ? (pausedPhase ?? .CHASE) : phase }
}

/// Words and symbols for the round's activity — the same language as the game screen's
/// phase banner. Role is always a symbol and a word; colour carries the crew.
enum RoundActivityText {
    typealias State = RoundActivityAttributes.ContentState

    static func roleLabel(_ role: RoundActivityAttributes.Role) -> String { role == .HIDING ? "Hiding" : "Seeking" }
    static func roleSymbol(_ role: RoundActivityAttributes.Role) -> String { role == .HIDING ? "eye.slash.fill" : "binoculars.fill" }

    static func title(_ s: State, role: RoundActivityAttributes.Role) -> String {
        let r = roleLabel(role)
        switch s.phase {
        case .HEAD_START: return "Head Start · \(r)"
        case .CHASE: return "Chase · \(r)"
        case .CAPTURE_PENDING: return "Catch Pending · \(r)"
        case .PAUSED: return s.safetyPause ? "Safety Pause" : "Paused"
        case .ENDED:
            switch s.outcome?.result {
            case .CAUGHT: return "Caught"
            case .TIMED_OUT: return "Not Caught"
            case .ABORTED, nil: return "Round Aborted"
            }
        }
    }

    /// Short phase word for tight spaces (Smart Stack, CarPlay).
    static func shortTitle(_ s: State) -> String {
        switch s.phase {
        case .HEAD_START: "Head Start"
        case .CHASE: "Chase"
        case .CAPTURE_PENDING: "Catch Pending"
        case .PAUSED: s.safetyPause ? "Safety Pause" : "Paused"
        case .ENDED: title(s, role: .HIDING)
        }
    }

    static func symbol(_ s: State, role: RoundActivityAttributes.Role) -> String {
        switch s.phase {
        case .PAUSED: s.safetyPause ? "exclamationmark.octagon.fill" : "pause.circle.fill"
        case .CAPTURE_PENDING: "camera.fill"
        case .ENDED: s.outcome?.result == .ABORTED ? "xmark.octagon.fill" : "flag.checkered"
        default: roleSymbol(role)
        }
    }

    /// What the big clock means.
    static func clockCaption(_ s: State) -> String {
        s.clockPhase == .HEAD_START ? "Head start left" : s.phase == .ENDED ? "Chase time" : "Chase"
    }

    /// The line under the clock that doesn't hold a live timer.
    static func detail(_ s: State, role: RoundActivityAttributes.Role, crew: String) -> String {
        switch s.phase {
        case .HEAD_START:
            return role == .HIDING ? "Move! First ping when this hits 0:00." : "Wait. First ping when this hits 0:00."
        case .CHASE:
            if s.pingWaiting { return role == .HIDING ? "Seekers wait on your ping. Get a GPS signal." : "The ping waits for the hiders’ GPS." }
            if let last = s.lastPing, last.missing { return "Ping \(last.index): no fresh GPS." }
            return role == .HIDING ? "Keep moving." : "Open the map for the latest ping."
        case .CAPTURE_PENDING:
            if role == .HIDING { return "Review the catch photo." }
            return s.claim?.crew == crew ? "Hiders are reviewing your catch. Clock frozen." : "Another crew claims a catch. Clock frozen."
        case .PAUSED:
            return "Clock and pings are frozen."
        case .ENDED:
            let time = clock(s.chaseElapsed ?? 0)
            switch s.outcome?.result {
            case .CAUGHT:
                if role == .HIDING { return "Found after \(time)." }
                return s.outcome?.creditCrews.contains(crew) == true ? "Your crew made the catch at \(time)." : "Caught by another crew at \(time)."
            case .TIMED_OUT: return "Survived at least \(time)."
            case .ABORTED, nil: return "No result this round."
            }
        }
    }

    /// m:ss or h:mm:ss (frozen clocks; running ones use the system timer).
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    /// Deep link that opens the night's game screen.
    static func url(_ a: RoundActivityAttributes) -> URL {
        var c = URLComponents()
        c.scheme = "manhuntcrews"
        c.host = "round"
        c.queryItems = [URLQueryItem(name: "session", value: a.sessionId), URLQueryItem(name: "round", value: a.roundId)]
        return c.url!
    }
}
