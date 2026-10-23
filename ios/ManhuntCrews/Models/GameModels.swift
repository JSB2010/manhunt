import Foundation
import CoreLocation

// Mirrors backend/src/domain/views.ts (`sessions/{sid}/views/{uid}`) and the
// session/round DTOs. All timestamps arrive as ISO-8601 UTC strings and are
// decoded with `JSONCoding.decoder`. Every clock shown in the app is computed
// from these *server* timestamps via `ServerClock`, never from a local timer.

/// A night has two or three crews.
enum TeamKey: String, Codable, CaseIterable, Identifiable, Comparable, Sendable {
    case A, B, C
    var id: String { rawValue }
    static func < (a: TeamKey, b: TeamKey) -> Bool { a.rawValue < b.rawValue }
    /// The crew's colour in words ("Blue crew"): an empty crew's name, and the Lock Screen label (ADR 0019).
    var colourName: String {
        switch self {
        case .A: "Blue crew"
        case .B: "Orange crew"
        case .C: "Green crew"
        }
    }
}

/// With two seeking crews: share the catch, or credit the crew that made it.
enum SeekMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case TOGETHER, RACE
    var id: String { rawValue }
    var label: String { self == .TOGETHER ? "Together" : "Race" }
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
    var maxChaseSeconds: Int?
    var confirmationTimeoutSeconds: Int
    var manualPausesEnabled: Bool
    var maxPingGpsAgeSeconds: Int
    var maxPingAccuracyMeters: Int

    static let defaults = Rules(
        headStartSeconds: 600, pingIntervalSeconds: 600, visiblePingHistoryCount: 1,
        maxChaseSeconds: nil, confirmationTimeoutSeconds: 120,
        manualPausesEnabled: true, maxPingGpsAgeSeconds: 60, maxPingAccuracyMeters: 50)
}

struct PersonRef: Codable, Hashable, Identifiable, Sendable {
    var personId: String
    var displayName: String
    var id: String { personId }
}

/// One phone on a crew. Every phone is equal; any one of them acts for the crew.
struct OperatorView: Codable, Hashable, Sendable {
    var uid: String
    var personId: String?
    var displayName: String
    var isMe: Bool
    var consentGiven: Bool
}

struct TeamView: Codable, Sendable {
    var teamId: String
    var key: TeamKey
    var name: String
    var color: String
    var roster: [PersonRef]
    var operators: [OperatorView]
    var isMine: Bool

    var hasPhone: Bool { !operators.isEmpty }
    var me: OperatorView? { operators.first(where: \.isMe) }
    /// More than one person: "Sasha & Marco hide", but "Sasha hides".
    var isPlural: Bool { roster.count > 1 }
    /// The phone a person on this crew carries.
    func phone(of personId: String) -> OperatorView? { operators.first { $0.personId == personId } }
}

/// People sitting out (in the night, not on a crew) and their phones, which spectate (ADR 0019).
struct SittingOutView: Codable, Equatable, Sendable {
    var roster: [PersonRef]
    var operators: [OperatorView]
    static let empty = SittingOutView(roster: [], operators: [])
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

/// Coarse phone status of a crew — counts and a state, never a time or a place.
struct CrewStatusView: Codable, Equatable, Sendable {
    var live: Int
    var total: Int
    var state: String // ACTIVE | STARTING | STALE | NO_SIGNAL | STOPPED | PERMISSION_ISSUE | UNKNOWN
    var issues: [String]
}

/// Pause and resume are between the two sides of a round: the hiders and the seekers.
enum Side: String, Codable, Sendable {
    case HIDERS, SEEKERS
    var label: String { self == .HIDERS ? "Hiders" : "Seekers" }
}

struct PauseView: Codable, Equatable, Sendable {
    var kind: String
    var reason: String?
    var startedAt: Date
    var byTeam: TeamKey?
    var resumeVotes: [String: Bool]
    var mySide: Side?

    func voted(_ side: Side) -> Bool { resumeVotes[side.rawValue] ?? false }
}

struct PendingPauseView: Codable, Equatable, Sendable {
    var byTeam: TeamKey
    var bySide: Side
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
    var byMe: Bool
}

/// A ping whose deadline passed with no hider fix yet; it goes out as soon as one arrives.
struct WaitingPingView: Codable, Equatable, Sendable {
    var index: Int
    var deadline: Date
    var since: Date
}

struct CaptureRequestView: Codable, Equatable, Sendable {
    var claimId: String
    var byTeam: TeamKey
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

/// Per-crew distances from the crew's best-covered phone. Crew-level, never per person.
struct CrewRouteStats: Codable, Equatable, Sendable {
    var role: Role
    var distanceTotalMeters: Double?
    var distanceChaseMeters: Double?
    var gpsCoverageFraction: Double?
    var routeQuality: String
    var phones: Int
}

struct RoundResult: Codable, Equatable, Sendable {
    var roundId: String
    var roundIndex: Int
    var hidingTeam: TeamKey
    var seekingTeams: [TeamKey]
    var seekMode: SeekMode
    var teamNames: [String: String]
    var rosterSnapshot: [String: [PersonRef]]
    /// Attribution only: RACE → the claiming crew, TOGETHER → every seeking crew.
    var catchCreditTeams: [TeamKey]
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
    var crews: [String: CrewRouteStats]
    var abortedReason: String?
    var resolvedByDispute: Bool

    func name(_ k: TeamKey) -> String { teamNames[k.rawValue] ?? "Crew \(k.rawValue)" }
    func crew(_ k: TeamKey) -> CrewRouteStats? { crews[k.rawValue] }
    var seekersName: String { seekingTeams.map(name).joined(separator: " & ") }
}

struct RoundView: Codable, Equatable, Sendable {
    var id: String
    var index: Int
    var state: RoundState
    var pausedFromState: RoundState?
    /// nil for a phone not playing this round (joined after it started)
    var myRole: Role?
    var myTeam: TeamKey?
    var hidingTeam: TeamKey
    var seekingTeams: [TeamKey]
    var seekMode: SeekMode
    var rules: Rules
    var ready: [String: Bool]
    var roundStartAt: Date?
    var headStartEndsAt: Date?
    var chaseStartAt: Date?
    var headStartClock: ClockView
    var chaseClock: ClockView?
    var nextPingAt: Date?
    var nextPingIndex: Int
    var waitingPing: WaitingPingView?
    var timeCapAt: Date?
    var pins: [PinView]
    var pingLog: [PingLogEntry]
    var pingCount: Int
    var pause: PauseView?
    var pendingPauseRequest: PendingPauseView?
    /// the crew whose claim is under review
    var claimByTeam: TeamKey?
    var myClaim: MyClaimView?
    var captureRequest: CaptureRequestView?
    var lastClaimOutcome: ClaimOutcomeView?
    var crewStatus: [String: CrewStatusView]
    var result: RoundResult?
    var endedAt: Date?
    var phaseGeneration: Int

    func isReady(_ team: TeamKey) -> Bool { ready[team.rawValue] ?? false }
    func status(_ team: TeamKey) -> CrewStatusView? { crewStatus[team.rawValue] }
    func role(of team: TeamKey) -> Role? { team == hidingTeam ? .HIDING : seekingTeams.contains(team) ? .SEEKING : nil }
    /// Hiders first, then the seekers.
    var teams: [TeamKey] { [hidingTeam] + seekingTeams }
    var isSpectator: Bool { myRole == nil && roundStartAt != nil }
    /// State to present while paused (the underlying phase).
    var effectiveState: RoundState { state == .PAUSED ? (pausedFromState ?? .CHASE) : state }
}

struct RoundBrief: Codable, Identifiable, Equatable, Sendable {
    var roundId: String
    var index: Int
    var hidingTeam: TeamKey
    var seekingTeams: [TeamKey]
    var seekMode: SeekMode
    var catchCreditTeams: [TeamKey]
    var outcome: String
    var observedChaseSeconds: Int
    var isRightCensored: Bool
    /// Crew names that round (absent on nights from before 2026-10-23).
    var teamNames: [String: String]?
    var id: String { roundId }

    /// The crew's name that round; a crew removed later keeps its name.
    func name(_ k: TeamKey, current: (TeamKey) -> String?) -> String {
        teamNames?[k.rawValue] ?? current(k) ?? "Crew \(k.rawValue)"
    }
}

struct SessionHeader: Codable, Sendable {
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    /// the organizer: only they can delete or revoke the night
    var isHost: Bool
    var myTeam: TeamKey?
    var completedRoundCount: Int
    var rules: Rules
    var teams: [String: TeamView]
    /// absent from servers before ADR 0019
    var sittingOut: SittingOutView?
    /// reusable night code; nil once the night ends
    var joinCode: String?
    var revoked: Bool

    func team(_ k: TeamKey) -> TeamView? { teams[k.rawValue] }
    /// Crews of the night in key order.
    var teamKeys: [TeamKey] { TeamKey.allCases.filter { teams[$0.rawValue] != nil } }
    /// The crew's people ("Sasha & Marco"), named by the server.
    func name(_ k: TeamKey) -> String { team(k)?.name ?? k.colourName }
    /// `one` for a crew of one ("hides"), `many` otherwise ("hide"); several crews are always plural.
    func verb(_ ks: [TeamKey], _ one: String, _ many: String) -> String {
        ks.count > 1 || ks.contains { team($0)?.isPlural ?? false } ? many : one
    }
    var bench: SittingOutView { sittingOut ?? .empty }
    /// This phone is in the night but its owner sits out.
    var amSittingOut: Bool { myTeam == nil && bench.operators.contains(where: \.isMe) }
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
    var viewHash: String?
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
        var phoneCount: Int
    }
    var id: String
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    var isHost: Bool
    var myTeam: TeamKey?
    var completedRoundCount: Int
    var teams: [String: TeamBrief]
    var createdAt: Date
}

struct SessionList: Codable, Sendable {
    var items: [SessionListItem]
    var nextBefore: Double?
}

/// The night's reusable code (and, for a friend invite, the direct invite id).
struct InviteCreated: Codable, Sendable {
    var code: String
    var inviteId: String?
    var expiresAt: Date
    var deepLink: String
}

struct InvitePreview: Codable, Sendable {
    struct TeamBrief: Codable, Sendable { var name: String; var color: String; var roster: [PersonRef]; var phoneCount: Int; var full: Bool }
    var sessionId: String
    var title: String
    var scheduledDate: String
    var teams: [String: TeamBrief]
    var suggestedTeam: TeamKey
    var myTeam: TeamKey?
    var hostDisplayName: String?
    var rules: Rules
    var expiresAt: Date
    /// Roster names another phone already plays as (ADR 0018).
    var claimedPersonIds: [String]?
    /// The roster name this account most likely is.
    var suggestedPersonId: String?
    /// People sitting out; joining as one of them puts them on a crew (ADR 0019).
    var sittingOut: [PersonRef]?

    var teamKeys: [TeamKey] { TeamKey.allCases.filter { teams[$0.rawValue] != nil } }
    /// The crew whose roster lists a person.
    func crew(of personId: String) -> TeamKey? {
        teamKeys.first { k in teams[k.rawValue]?.roster.contains { $0.personId == personId } ?? false }
    }
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
