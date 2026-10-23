import Foundation
import CoreLocation

// Post-round recap, routes, analytics and social DTOs.

struct RoundSummary: Codable, Sendable {
    struct Ping: Codable, Identifiable, Sendable {
        var index: Int
        var scheduledAt: Date?
        var releasedAt: Date?
        var observedAt: Date?
        var status: String
        var latitude: Double?
        var longitude: Double?
        var accuracyMeters: Double?
        var ageSeconds: Int?
        var delayed: Bool
        var id: Int { index }
        var coordinate: CLLocationCoordinate2D? {
            guard let latitude, let longitude else { return nil }
            return .init(latitude: latitude, longitude: longitude)
        }
    }
    struct Claim: Codable, Identifiable, Sendable {
        var claimId: String
        var team: TeamKey?
        var status: String
        var submittedAt: Date?
        var reviewedAt: Date?
        var rejectionReason: String?
        var chaseSecondsAtClaim: Int?
        /// nil when there is no photo, or this phone may not see it (another crew's RACE claim)
        var photoPath: String?
        var id: String { claimId }
    }
    struct TimelineEvent: Codable, Identifiable, Sendable {
        /// Audit details are flat strings, numbers and booleans (never coordinates).
        enum Detail: Codable, Sendable {
            case string(String), number(Double), bool(Bool), null
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if c.decodeNil() { self = .null }
                else if let b = try? c.decode(Bool.self) { self = .bool(b) }
                else if let n = try? c.decode(Double.self) { self = .number(n) }
                else { self = .string(try c.decode(String.self)) }
            }
            func encode(to encoder: Encoder) throws {
                var c = encoder.singleValueContainer()
                switch self {
                case let .string(v): try c.encode(v)
                case let .number(v): try c.encode(v)
                case let .bool(v): try c.encode(v)
                case .null: try c.encodeNil()
                }
            }
            var int: Int? { if case let .number(n) = self { Int(n) } else { nil } }
            var string: String? { if case let .string(v) = self { v } else { nil } }
            var isTrue: Bool { if case .bool(true) = self { true } else { false } }
        }
        var type: String
        var at: Date?
        var details: [String: Detail]?
        var id: String { "\(type)-\(at?.timeIntervalSince1970 ?? 0)-\(details?["pingIndex"]?.int ?? -1)" }

        /// Lobby events (ready taps, setup edits) that recaps from before 2026-10-23 still list.
        static let lobbyTypes: Set<String> = ["ROUND_CREATED", "SETUP_EDITED", "READY_CHANGED", "CONSENT_GIVEN", "OPERATOR_JOINED", "OPERATOR_MOVED", "PING_DELAYED"]

        /// What happened, in words ("Ping 2 released", "Crew B claimed a catch").
        func label(name: (TeamKey) -> String) -> String {
            let ping = details?["pingIndex"]?.int.map { "Ping \($0)" } ?? "Ping"
            let crew = details?["team"]?.string.flatMap(TeamKey.init(rawValue:)).map(name)
            switch type {
            case "ROUND_STARTED": return "Round started"
            case "CHASE_STARTED": return "Chase started"
            case "PING_RELEASED": return details?["late"]?.isTrue == true ? "\(ping) released late" : "\(ping) released"
            case "PING_WAITING": return "\(ping) waiting for the hiders’ GPS"
            case "PING_MISSING": return "\(ping) missed (no GPS)"
            case "CLAIM_SUBMITTED": return "\(crew ?? "Seekers") claimed a catch"
            case "CLAIM_CONFIRMED": return "Catch confirmed"
            case "CLAIM_REJECTED": return "Claim rejected"
            case "CLAIM_EXPIRED": return "Claim expired (no answer)"
            case "PAUSE_REQUESTED": return "\(crew ?? "A crew") asked to pause"
            case "PAUSE_STARTED": return details?["kind"]?.string == "SAFETY" ? "Safety pause" : "Paused"
            case "RESUME_VOTE": return "\(crew ?? "A crew") ready to resume"
            case "RESUMED": return "Resumed"
            case "ROUND_TIMED_OUT": return "Time cap reached"
            case "ROUND_ABORTED": return "Round aborted"
            case "OPERATOR_REMOVED": return "A phone left the round"
            case "DISPUTE_PROPOSED": return "\(crew ?? "A crew") proposed a settlement"
            case "DISPUTE_RESOLVED": return "Claim settled"
            default: return type.replacingOccurrences(of: "_", with: " ").capitalized
            }
        }
    }
    struct Pause: Codable, Sendable {
        var kind: String
        var startAt: Date?
        var endAt: Date?
        var reason: String?
    }
    var roundId: String
    var index: Int
    var state: RoundState
    var summaryReady: Bool
    var hidingTeam: TeamKey
    var seekingTeams: [TeamKey]
    var seekMode: SeekMode
    var myTeam: TeamKey?
    var teamNames: [String: String]
    var teamColors: [String: String?]
    var rules: Rules
    var result: RoundResult?
    var roundStartAt: Date?
    var chaseStartAt: Date?
    var endedAt: Date?
    var pings: [Ping]
    var claims: [Claim]
    var timeline: [TimelineEvent]
    var pauses: [Pause]
    var routesAvailable: Bool
}

struct RouteRecap: Codable, Sendable {
    struct Point: Codable, Sendable {
        var latitude: Double
        var longitude: Double
        var t: Date?
        var coordinate: CLLocationCoordinate2D { .init(latitude: latitude, longitude: longitude) }
    }
    struct Segment: Codable, Sendable { var points: [Point] }
    struct Team: Codable, Sendable {
        var team: TeamKey
        var role: Role
        var deleted: Bool
        var quality: String
        var sampleCount: Int
        var segments: [Segment]
    }
    struct Markers: Codable, Sendable {
        var roundStartAt: Date?
        var chaseStartAt: Date?
        var officialEndAt: Date?
        var claimPoint: Point?
    }
    var roundId: String
    var revision: Int
    var teams: [String: Team]
    var markers: Markers
}

struct TeamScore: Codable, Sendable {
    var team: TeamKey
    var name: String
    var hideRoundCount: Int
    var abortedHideRounds: Int
    var caughtCount: Int
    var uncaughtCount: Int
    var hideSurvivalTotalSeconds: Int
    var hideSurvivalAverageSeconds: Int?
    var hideSurvivalAverageIncludesCensored: Bool
    var caughtOnlyHideAverageSeconds: Int?
    var seekRoundCount: Int
    var seekCreditedCatches: Int
    var seekCaptureAverageSeconds: Int?
    var seekUncaughtCount: Int
    var seekCaughtByOtherCrew: Int
    var hiderFootMetersTotal: Double
    var hiderFootMetersChase: Double
    var seekerVehicleMetersChase: Double
    var meanHiderCoverage: Double?
    var meanSeekerCoverage: Double?
}

struct NightComparison: Codable, Sendable {
    var status: String // COMPARABLE | PROVISIONAL | INSUFFICIENT
    var strongerHidingTeam: TeamKey?
    var marginSeconds: Int?
    var reasons: [String]
    var explanation: String
}

/// Rounds with the same people on each crew and the same rules: the only fair comparison (ADR 0019).
struct Matchup: Codable, Identifiable, Sendable {
    struct Crew: Codable, Identifiable, Sendable {
        /// its colour in the matchup's first round
        var team: TeamKey
        var name: String
        var people: [PersonRef]
        var hideRounds: Int
        var hideAverageSeconds: Int?
        var hideIncludesCensored: Bool
        var caught: Int
        var uncaught: Int
        var seekRounds: Int
        var catches: Int
        var hiderFootMeters: Double
        var seekerVehicleMeters: Double
        var id: TeamKey { team }
    }
    var rounds: [Int]
    var rulesFingerprint: String
    var crews: [Crew]
    var comparison: NightComparison
    var id: String { rounds.map(String.init).joined(separator: ",") }

    /// "Round 3", "Rounds 1–2", "Rounds 1, 2 & 5".
    var title: String {
        guard let first = rounds.first, let last = rounds.last else { return "" }
        if rounds.count == 1 { return "Round \(first)" }
        if rounds == Array(first...last) { return "Rounds \(first)–\(last)" }
        return "Rounds \(rounds.map(String.init).formatted(.list(type: .and)))"
    }
}

/// One person's night, crew-attributed: never individual performance.
struct PersonNightStats: Codable, Identifiable, Sendable {
    var personId: String
    var displayName: String
    var roundsHid: Int
    var roundsSought: Int
    var hideAverageSeconds: Int?
    var hideIncludesCensored: Bool
    var catches: Int
    var id: String { personId }
}

/// What changed since the previous round.
struct RoundChanges: Codable, Sendable {
    struct Move: Codable, Sendable { var name: String; var from: TeamKey; var to: TeamKey }
    struct RuleChange: Codable, Sendable {
        var field: String
        var from: RoundSummary.TimelineEvent.Detail
        var to: RoundSummary.TimelineEvent.Detail
    }
    var roundIndex: Int
    var joined: [String]
    var left: [String]
    var moved: [Move]
    var rules: [RuleChange]
    var isEmpty: Bool { joined.isEmpty && left.isEmpty && moved.isEmpty && rules.isEmpty }
}

struct Scorecard: Codable, Sendable {
    struct Trend: Codable, Identifiable, Sendable {
        var roundIndex: Int
        var hidingTeam: TeamKey
        var observedChaseSeconds: Int
        var isRightCensored: Bool
        var outcome: String
        var id: Int { roundIndex }
    }
    var teams: [String: TeamScore]
    var comparison: NightComparison
    var rulesConsistent: Bool
    var rounds: [RoundResult]
    var trend: [Trend]
    /// absent from servers before ADR 0019
    var matchups: [Matchup]?
    var people: [PersonNightStats]?
    var changes: [RoundChanges]?

    func changes(before roundIndex: Int) -> RoundChanges? { changes?.first { $0.roundIndex == roundIndex } }
}

struct SessionAnalytics: Codable, Sendable {
    struct TeamInfo: Codable, Sendable { var name: String; var color: String; var roster: [PersonRef] }
    var sessionId: String
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    var playedRounds: Int
    var teams: [String: TeamInfo]
    var scorecard: Scorecard
    var notDirectlyComparable: Bool
}

// MARK: - Social

struct PublicProfile: Codable, Identifiable, Hashable, Sendable {
    var uid: String
    var displayName: String
    var handle: String?
    var id: String { uid }
}

struct MeResponse: Codable, Sendable {
    struct Profile: Codable, Sendable {
        struct Prefs: Codable, Sendable { var units: String; var notifyPings: Bool; var notifyRoundEvents: Bool }
        var uid: String
        var displayName: String
        var handle: String?
        var email: String?
        var selfPersonId: String
        var preferences: Prefs
        var friendInviteLink: String
    }
    struct Counts: Codable, Sendable { var friends: Int; var incomingFriendRequests: Int; var groups: Int }
    struct PendingInvite: Codable, Identifiable, Sendable {
        var inviteId: String
        var sessionId: String
        var sessionTitle: String
        var teamName: String?
        var hostDisplayName: String?
        var expiresAt: Date
        var id: String { inviteId }
    }
    struct ActiveSession: Codable, Identifiable, Sendable { var id: String; var title: String; var status: String; var scheduledDate: String }
    var profile: Profile
    var counts: Counts
    var pendingSessionInvites: [PendingInvite]
    var activeSessions: [ActiveSession]
}

struct FriendsResponse: Codable, Sendable { var friends: [PublicProfile]; var blocked: [PublicProfile] }

struct FriendRequestsResponse: Codable, Sendable {
    struct Item: Codable, Identifiable, Sendable { var requestId: String; var user: PublicProfile; var createdAt: Date; var id: String { requestId } }
    var incoming: [Item]
    var outgoing: [Item]
}

struct FriendRequestResult: Codable, Sendable { var status: String; var requestId: String? }

struct Person: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var displayName: String
    var aliases: [String]
    var isSelf: Bool
    var hasAccount: Bool
    var canEdit: Bool
    var mergedInto: String?
}

struct PeopleResponse: Codable, Sendable { var people: [Person] }
struct CreatePersonResponse: Codable, Sendable { var created: Bool; var person: Person?; var possibleDuplicates: [Person] }

struct LinkRequestsResponse: Codable, Sendable {
    struct Item: Codable, Identifiable, Sendable { var requestId: String; var person: Person?; var requester: PublicProfile?; var id: String { requestId } }
    var requests: [Item]
}

struct GroupsResponse: Codable, Sendable {
    struct Group: Codable, Identifiable, Hashable, Sendable {
        var id: String
        var name: String
        var isOwner: Bool
        var canEdit: Bool
        var memberUids: [String]
        var people: [Person]
    }
    var groups: [Group]
}

struct IdResponse: Codable, Sendable { var id: String }

struct PersonAnalyticsResponse: Codable, Sendable {
    struct Analytics: Codable, Sendable {
        struct Hide: Codable, Sendable { var rounds: Int; var averageSeconds: Int?; var caught: Int; var censored: Int; var includesCensored: Bool }
        struct Seek: Codable, Sendable { var rounds: Int; var averageSeconds: Int?; var uncaught: Int; var caughtByOtherCrew: Int }
        struct Paired: Codable, Sendable { var stronger: Int; var weaker: Int; var tied: Int; var provisional: Int; var insufficient: Int }
        struct Composition: Codable, Identifiable, Sendable { var fingerprint: String; var members: [PersonRef]; var rounds: Int; var hideRounds: Int; var hideAverageSeconds: Int?; var censoredHideRounds: Int; var id: String { fingerprint } }
        struct CoPlayer: Codable, Identifiable, Sendable { var personId: String; var displayName: String; var sessionsTogether: Int; var id: String { personId } }
        struct SessionRef: Codable, Identifiable, Sendable { var sessionId: String; var title: String; var scheduledDate: String; var crewNames: [String]; var id: String { sessionId } }
        var attribution: String
        var sessionsPlayed: Int
        var roundsCrewHid: Int
        var roundsCrewSought: Int
        var crewHideSurvival: Hide
        var crewSeekCapture: Seek
        var pairedNights: Paired
        var compositions: [Composition]
        var coPlayers: [CoPlayer]
        var operatorRounds: Int?
        var sessions: [SessionRef]
        var sampleNote: String
    }
    var person: Person
    var analytics: Analytics
}

struct DeleteMyDataResponse: Codable, Sendable { var pointsDeleted: Int; var photosDeleted: Int }
struct DeleteAccountResponse: Codable, Sendable { var status: String }
