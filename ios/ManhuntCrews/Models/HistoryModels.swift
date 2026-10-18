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
        var status: String
        var submittedAt: Date?
        var reviewedAt: Date?
        var rejectionReason: String?
        var chaseSecondsAtClaim: Int?
        var hasPhoto: Bool
        var photoPath: String?
        var id: String { claimId }
    }
    struct TimelineEvent: Codable, Identifiable, Sendable {
        var type: String
        var at: Date?
        var id: String { "\(type)-\(at?.timeIntervalSince1970 ?? 0)" }
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
    var seekingTeam: TeamKey
    var teamNames: [String: String]
    var teamColors: [String: String]
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
    var seekCaptureAverageSeconds: Int?
    var seekUncaughtCount: Int
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
}

struct SessionAnalytics: Codable, Sendable {
    struct TeamInfo: Codable, Sendable { var name: String; var color: String; var roster: [PersonRef] }
    var sessionId: String
    var title: String
    var scheduledDate: String
    var status: SessionStatus
    var plannedRounds: Int
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
        var teamName: String
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
        struct Seek: Codable, Sendable { var rounds: Int; var averageSeconds: Int?; var uncaught: Int }
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
