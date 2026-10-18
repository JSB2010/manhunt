import Foundation
import CoreLocation

// Mirrors backend/src/domain/views.ts (`sessions/{sid}/views/{uid}`) and the
// session/round DTOs. All timestamps arrive as ISO-8601 UTC strings and are
// decoded with `JSONCoding.decoder`. Every clock shown in the app is computed
// from these *server* timestamps via `ServerClock`, never from a local timer.

enum TeamKey: String, Codable, CaseIterable, Identifiable, Sendable {
    case A, B
    var id: String { rawValue }
    var other: TeamKey { self == .A ? .B : .A }
}

enum Role: String, Codable, Sendable {
    case HIDING, SEEKING
    var label: String { self == .HIDING ? "Hiding" : "Seeking" }
}

enum SessionStatus: String, Codable, Sendable {
    case LOBBY, IN_ROUND, BETWEEN_ROUNDS, COMPLETED
}

enum RoundState: String, Codable, Sendable {
    case READY, HEAD_START, CHASE, CAPTURE_PENDING, PAUSED, COMPLETED, TIMED_OUT, ABORTED

    var isActive: Bool { [.HEAD_START, .CHASE, .CAPTURE_PENDING, .PAUSED].contains(self) }
    var isFinished: Bool { [.COMPLETED, .TIMED_OUT, .ABORTED].contains(self) }
    var label: String {
        switch self {
        case .READY: "Ready check"
        case .HEAD_START: "Head start"
        case .CHASE: "Chase"
        case .CAPTURE_PENDING: "Catch pending"
        case .PAUSED: "Paused"
        case .COMPLETED: "Caught"
        case .TIMED_OUT: "Timed out"
        case .ABORTED: "Aborted"
        }
    }
}

struct Rules: Codable, Equatable, Sendable {
    var headStartSeconds: Int
    var pingIntervalSeconds: Int
    var visiblePingHistoryCount: Int?
    var totalRounds: Int
    var initialHidingTeam: TeamKey
    var alternateRoles: Bool
    var maxChaseSeconds: Int?
    var confirmationTimeoutSeconds: Int
    var manualPausesEnabled: Bool
    var maxPingGpsAgeSeconds: Int
    var maxPingAccuracyMeters: Int

    static let defaults = Rules(
        headStartSeconds: 600, pingIntervalSeconds: 600, visiblePingHistoryCount: 1, totalRounds: 4,
        initialHidingTeam: .A, alternateRoles: true, maxChaseSeconds: nil, confirmationTimeoutSeconds: 120,
        manualPausesEnabled: true, maxPingGpsAgeSeconds: 60, maxPingAccuracyMeters: 50)
}

struct PersonRef: Codable, Hashable, Identifiable, Sendable {
    var personId: String
    var displayName: String
    var id: String { personId }
}

struct TeamView: Codable, Sendable {
    var teamId: String
    var key: TeamKey
    var name: String
    var color: String
    var roster: [PersonRef]
    var operatorDisplayName: String?
    var hasOperator: Bool
    var isMine: Bool
    var consentGiven: Bool
}

struct ClockView: Codable, Equatable, Sendable {
    var accumulatedMs: Double
    var runningSince: Date?

    /// Elapsed milliseconds at server time `now`.
    func elapsedMs(at now: Date) -> Double {
        guard let since = runningSince else { return accumulatedMs }
        return accumulatedMs + max(0, now.timeIntervalSince(since) * 1000)
    }
}

struct PinView: Codable, Identifiable, Hashable, Sendable {
    var index: Int
    var scheduledAt: Date
    var releasedAt: Date
    var observedAt: Date?
    var latitude: Double
    var longitude: Double
    var accuracyMeters: Double?
    var ageSeconds: Int?
    var delayed: Bool
    var id: Int { index }
    var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
}

struct PingLogEntry: Codable, Identifiable, Hashable, Sendable {
    var index: Int
    var scheduledAt: Date
    var releasedAt: Date
    var status: String // RELEASED | NO_FRESH_FIX
    var ageSeconds: Int?
    var accuracyMeters: Double?
    var delayed: Bool
    var id: Int { index }
    var isMissing: Bool { status == "NO_FRESH_FIX" }
}

struct HealthView: Codable, Equatable, Sendable {
    var lastHeartbeatAt: Date?
    var lastSampleRecordedAt: Date?
    var lastSampleAccuracyMeters: Double?
    var permission: String
    var preciseLocation: Bool
    var trackingActive: Bool
    var backgroundSessionActive: Bool
    var lowPowerMode: Bool
    var batteryLevel: Double?
    var networkReachable: Bool
    var queuedSamples: Int
}

struct OpponentHealthView: Codable, Equatable, Sendable {
    var state: String // ACTIVE | STALE | NO_SIGNAL | STOPPED | PERMISSION_ISSUE | UNKNOWN
    var lastHeartbeatAt: Date?
    var issues: [String]
}

struct PauseView: Codable, Equatable, Sendable {
    var kind: String
    var reason: String?
    var startedAt: Date
    var byTeam: TeamKey?
    var resumeVotes: [String: Bool]
}

struct PendingPauseView: Codable, Equatable, Sendable {
    var byTeam: TeamKey
    var at: Date
    var expiresAt: Date
    var reason: String?
    var mine: Bool
}

struct MyClaimView: Codable, Equatable, Sendable {
    var claimId: String
    var status: String
    var submittedAt: Date?
    var expiresAt: Date?
}

struct CaptureRequestView: Codable, Equatable, Sendable {
    var claimId: String
    var submittedAt: Date
    var expiresAt: Date?
    var chaseSecondsAtClaim: Int?
    var photoPath: String
}

struct ClaimOutcomeView: Codable, Equatable, Sendable {
    var status: String
    var at: Date
    var reason: String?
}

struct RoundResult: Codable, Equatable, Sendable {
    var roundId: String
    var roundIndex: Int
    var hidingTeam: TeamKey
    var seekingTeam: TeamKey
    var hidingTeamName: String
    var seekingTeamName: String
    var hidingRosterSnapshot: [PersonRef]
    var seekingRosterSnapshot: [PersonRef]
    var outcome: String // CAUGHT | TIMED_OUT | ABORTED
    var headStartSeconds: Int
    var observedChaseSeconds: Int
    var isRightCensored: Bool
    var officialFoundAt: Double?
    var confirmedAt: Double?
    var totalPauseSeconds: Int
    var roundElapsedSeconds: Int
    var pingSlots: Int
    var pingsReleased: Int
    var pingsMissing: Int
    var pingsDelayed: Int
    var hidingDistanceTotalMeters: Double?
    var hidingDistanceChaseMeters: Double?
    var seekingDistanceChaseMeters: Double?
    var gpsCoverageFractionHider: Double?
    var gpsCoverageFractionSeeker: Double?
    var routeQualityHider: String
    var routeQualitySeeker: String
    var abortedReason: String?
    var resolvedByDispute: Bool
}

struct RoundView: Codable, Equatable, Sendable {
    var id: String
    var index: Int
    var state: RoundState
    var pausedFromState: RoundState?
    var myRole: Role?
    var hidingTeam: TeamKey
    var seekingTeam: TeamKey
    var rules: Rules
    var ready: [String: Bool]
    var roleOverride: RoleOverrideView?
    var roundStartAt: Date?
    var headStartEndsAt: Date?
    var chaseStartAt: Date?
    var headStartClock: ClockView
    var chaseClock: ClockView?
    var nextPingAt: Date?
    var nextPingIndex: Int
    var timeCapAt: Date?
    var pins: [PinView]
    var pingLog: [PingLogEntry]
    var pause: PauseView?
    var pendingPauseRequest: PendingPauseView?
    var myClaim: MyClaimView?
    var captureRequest: CaptureRequestView?
    var lastClaimOutcome: ClaimOutcomeView?
    var myHealth: HealthView?
    var opponentHealth: OpponentHealthView
    var result: RoundResult?
    var endedAt: Date?
    var phaseGeneration: Int

    func isReady(_ team: TeamKey) -> Bool { ready[team.rawValue] ?? false }
    /// State to present while paused (the underlying phase).
    var effectiveState: RoundState { state == .PAUSED ? (pausedFromState ?? .CHASE) : state }
}

struct RoleOverrideView: Codable, Equatable, Sendable {
    var reason: String?
    var suggestedHidingTeam: TeamKey
}

struct RoundBrief: Codable, Identifiable, Equatable, Sendable {
    var roundId: String
    var index: Int
    var hidingTeam: TeamKey
    var outcome: String
    var observedChaseSeconds: Int
    var isRightCensored: Bool
    var id: String { roundId }
}

struct SessionHeader: Codable, Sendable {
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    var isHost: Bool
    var myTeam: TeamKey?
    var totalRounds: Int
    var completedRoundCount: Int
    var rules: Rules
    var teams: [String: TeamView]
    var revoked: Bool

    func team(_ k: TeamKey) -> TeamView? { teams[k.rawValue] }
}

struct NextRoundView: Codable, Equatable, Sendable {
    var index: Int
    var suggestedHidingTeam: TeamKey
}

struct SessionViewDoc: Codable, Sendable {
    var schemaVersion: Int
    var uid: String
    var sessionId: String
    var renderedAt: Date
    var stateVersion: Double
    var session: SessionHeader
    var round: RoundView?
    var previousRounds: [RoundBrief]
    var nextRound: NextRoundView?
}


// MARK: - Session list / invites

struct SessionListItem: Codable, Identifiable, Sendable {
    struct TeamBrief: Codable, Sendable {
        var name: String
        var color: String
        var roster: [PersonRef]
        var operatorDisplayName: String?
    }
    var id: String
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    var isHost: Bool
    var myTeam: TeamKey?
    var totalRounds: Int
    var completedRoundCount: Int
    var teams: [String: TeamBrief]
    var createdAt: Date
}

struct SessionList: Codable, Sendable {
    var items: [SessionListItem]
    var nextBefore: Double?
}

struct InviteCreated: Codable, Sendable {
    var inviteId: String
    var code: String
    var teamKey: TeamKey
    var expiresAt: Date
    var deepLink: String
}

struct InvitePreview: Codable, Sendable {
    struct TeamBrief: Codable, Sendable { var name: String; var roster: [PersonRef] }
    var sessionId: String
    var title: String
    var scheduledDate: String
    var teamKey: TeamKey
    var teams: [String: TeamBrief]
    var hostDisplayName: String?
    var rules: Rules
    var expiresAt: Date
}

struct CaptureTicket: Codable, Sendable {
    var claimId: String
    var uploadPath: String
    var uploadMethod: String
    var contentType: String
    var maxBytes: Int
    var expiresAt: Date
}

struct OkResponse: Codable, Sendable { var ok: Bool? }

struct LocationBatchResponse: Codable, Sendable {
    struct Rejected: Codable, Sendable { var pointId: String; var reason: String }
    var accepted: Int
    var duplicates: Int
    var rejected: [Rejected]
    var clockSkewMs: Double
}

struct MyTrack: Codable, Sendable {
    struct Point: Codable, Sendable { var pointId: String; var recordedAt: Date; var latitude: Double; var longitude: Double; var horizontalAccuracyMeters: Double }
    var points: [Point]
}
