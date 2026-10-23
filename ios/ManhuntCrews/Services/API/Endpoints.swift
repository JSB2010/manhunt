import Foundation

// Request bodies (mirror backend/src/schemas/api.ts — unknown keys are rejected server-side).

struct RosterEntryBody: Codable, Hashable, Sendable {
    var personId: String?
    var displayName: String
}

/// A crew's people. Crews are named after their people by the server (ADR 0019).
struct TeamInputBody: Codable, Sendable {
    var roster: [RosterEntryBody]
}

struct RulesPatch: Codable, Sendable {
    var headStartSeconds: Int?
    var pingIntervalSeconds: Int?
    var visiblePingHistoryCount: Int??
    var maxChaseSeconds: Int??
    var confirmationTimeoutSeconds: Int?
    var manualPausesEnabled: Bool?
    var maxPingGpsAgeSeconds: Int?
    var maxPingAccuracyMeters: Int?

    init(_ r: Rules) {
        headStartSeconds = r.headStartSeconds
        pingIntervalSeconds = r.pingIntervalSeconds
        visiblePingHistoryCount = .some(r.visiblePingHistoryCount)
        maxChaseSeconds = .some(r.maxChaseSeconds)
        confirmationTimeoutSeconds = r.confirmationTimeoutSeconds
        manualPausesEnabled = r.manualPausesEnabled
        maxPingGpsAgeSeconds = r.maxPingGpsAgeSeconds
        maxPingAccuracyMeters = r.maxPingAccuracyMeters
    }

    // Encode double-optionals as explicit null so "show all pins" / "no cap" survive.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(headStartSeconds, forKey: .headStartSeconds)
        try c.encodeIfPresent(pingIntervalSeconds, forKey: .pingIntervalSeconds)
        if let v = visiblePingHistoryCount { try c.encode(v, forKey: .visiblePingHistoryCount) }
        if let v = maxChaseSeconds { try c.encode(v, forKey: .maxChaseSeconds) }
        try c.encodeIfPresent(confirmationTimeoutSeconds, forKey: .confirmationTimeoutSeconds)
        try c.encodeIfPresent(manualPausesEnabled, forKey: .manualPausesEnabled)
        try c.encodeIfPresent(maxPingGpsAgeSeconds, forKey: .maxPingGpsAgeSeconds)
        try c.encodeIfPresent(maxPingAccuracyMeters, forKey: .maxPingAccuracyMeters)
    }
}

struct CreateSessionBody: Encodable, Sendable {
    var title: String
    var scheduledDate: String
    var myTeam: TeamKey
    /// two or three crews keyed A, B[, C]
    var teams: [String: TeamInputBody]
    /// people sitting out to begin with (not here yet)
    var bench: [RosterEntryBody]?
    var firstHidingTeam: TeamKey?
    var seekMode: SeekMode?
    var rules: RulesPatch
    var groupId: String?
}

/// Between-rounds editor (ADR 0019). Rosters and `bench` place people, and every phone follows its
/// owner; someone on no list leaves the night (with their phone). `moves` with teamKey nil takes a
/// phone out of the night while its owner keeps playing. A crew set to `.remove` is deleted.
struct SetupPatchBody: Encodable, Sendable {
    enum CrewEdit: Encodable, Sendable {
        case edit(TeamPatch)
        case remove
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .edit(let p): try c.encode(p)
            case .remove: try c.encodeNil()
            }
        }
    }
    struct TeamPatch: Encodable, Sendable { var roster: [RosterEntryBody]? }
    struct Move: Encodable, Sendable {
        var uid: String
        var teamKey: TeamKey?
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(uid, forKey: .uid)
            try c.encode(teamKey, forKey: .teamKey) // explicit null = remove
        }
        enum CodingKeys: String, CodingKey { case uid, teamKey }
    }
    var title: String?
    var rules: RulesPatch?
    var teams: [String: CrewEdit]?
    var bench: [RosterEntryBody]?
    var moves: [Move]?
}

struct HealthPayload: Codable, Sendable {
    var permission: String
    var preciseLocation: Bool
    var trackingActive: Bool
    var backgroundSessionActive: Bool
    var lowPowerMode: Bool
    var batteryLevel: Double?
    var networkReachable: Bool
    var appVersion: String?
    var queuedSamples: Int
    var lastFixAgeSeconds: Double?
    var lastFixAccuracyMeters: Double?
}

struct SamplePayload: Codable, Hashable, Sendable {
    var pointId: String
    var recordedAt: Date
    var latitude: Double
    var longitude: Double
    var horizontalAccuracyMeters: Double
    var speedMetersPerSecond: Double?
    var courseDegrees: Double?
    var altitudeMeters: Double?
}

struct LocationBatchBody: Encodable, Sendable {
    var batchId: String
    var sentAt: Date
    var samples: [SamplePayload]
    var health: HealthPayload
}

/// Typed endpoint helpers.
extension APIClient {
    // Account
    func me() async throws -> MeResponse { try await get("/v1/me") }
    func patchMe(displayName: String? = nil, handle: String? = nil, units: String? = nil, notifyPings: Bool? = nil) async throws -> MeResponse {
        struct Prefs: Encodable { var units: String?; var notifyPings: Bool? }
        struct Body: Encodable { var displayName: String?; var handle: String?; var preferences: Prefs? }
        let prefs = (units != nil || notifyPings != nil) ? Prefs(units: units, notifyPings: notifyPings) : nil
        return try await patch("/v1/me", Body(displayName: displayName, handle: handle, preferences: prefs))
    }
    func deleteAccount() async throws -> DeleteAccountResponse { try await delete("/v1/me") }
    func registerPushToken(deviceId: String, token: String, environment: String, appVersion: String) async throws {
        struct Body: Encodable { var deviceId: String; var fcmToken: String; var apnsEnvironment: String; var appVersion: String }
        let _: OkResponse = try await post("/v1/devices/push-token", Body(deviceId: deviceId, fcmToken: token, apnsEnvironment: environment, appVersion: appVersion))
    }

    // Live Activities (ADR 0017)
    func registerLiveActivity(_ sid: String, _ rid: String, deviceId: String, pushToken: String, clockOffsetMs: Int) async throws {
        struct Body: Encodable { var pushToken: String; var clockOffsetMs: Int }
        let _: OkResponse = try await send("PUT", "/v1/sessions/\(sid)/rounds/\(rid)/live-activity/\(deviceId)", body: Body(pushToken: pushToken, clockOffsetMs: clockOffsetMs))
    }
    func unregisterLiveActivity(_ sid: String, _ rid: String, deviceId: String) async throws {
        let _: OkResponse = try await delete("/v1/sessions/\(sid)/rounds/\(rid)/live-activity/\(deviceId)")
    }
    /// `token` nil: Live Activities are off on this device; the server stops push-starting them.
    func registerLiveActivityStartToken(deviceId: String, token: String?) async throws {
        struct Body: Encodable {
            var deviceId: String
            var pushToStartToken: String?
            enum CodingKeys: String, CodingKey { case deviceId, pushToStartToken }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(deviceId, forKey: .deviceId)
                try c.encode(pushToStartToken, forKey: .pushToStartToken) // explicit null = off
            }
        }
        let _: OkResponse = try await post("/v1/devices/live-activity-token", Body(deviceId: deviceId, pushToStartToken: token))
    }

    // Sessions
    func createSession(_ body: CreateSessionBody) async throws -> SessionViewDoc { try await post("/v1/sessions", body) }
    func sessions(query: String? = nil, before: Double? = nil) async throws -> SessionList {
        var q: [URLQueryItem] = [.init(name: "limit", value: "30")]
        if let query, !query.isEmpty { q.append(.init(name: "q", value: query)) }
        if let before { q.append(.init(name: "before", value: String(Int(before)))) }
        return try await get("/v1/sessions", query: q)
    }
    func session(_ id: String) async throws -> SessionViewDoc { try await get("/v1/sessions/\(id)") }
    /// The stored view only if it changed since `etag` (its view hash); nil on 304 (no body sent).
    func session(_ id: String, ifNoneMatch etag: String?) async throws -> SessionViewDoc? {
        let (data, http) = try await raw("GET", "/v1/sessions/\(id)", headers: etag.map { ["If-None-Match": "\"\($0)\""] } ?? [:])
        return http.statusCode == 304 ? nil : try decode(data)
    }
    /// The night's reusable code (fetched, not re-created). `regenerate` revokes the old one.
    func nightCode(_ sid: String, regenerate: Bool = false, targetUid: String? = nil) async throws -> InviteCreated {
        struct Body: Encodable { var targetUid: String?; var regenerate: Bool? }
        return try await post("/v1/sessions/\(sid)/invites", Body(targetUid: targetUid, regenerate: regenerate ? true : nil))
    }
    func previewInvite(code: String? = nil, inviteId: String? = nil) async throws -> InvitePreview {
        struct Body: Encodable { var code: String?; var inviteId: String? }
        return try await post("/v1/invites/preview", Body(code: code, inviteId: inviteId))
    }
    /// `personId`: the roster name the joiner plays as ("That's me", ADR 0018).
    func redeemInvite(code: String? = nil, inviteId: String? = nil, teamKey: TeamKey? = nil, personId: String? = nil) async throws -> SessionViewDoc {
        struct Body: Encodable { var code: String?; var inviteId: String?; var teamKey: TeamKey?; var personId: String? }
        return try await post("/v1/invites/redeem", Body(code: code, inviteId: inviteId, teamKey: teamKey, personId: personId))
    }
    func editSetup(_ sid: String, _ body: SetupPatchBody) async throws { let _: OkResponse = try await patch("/v1/sessions/\(sid)/setup", body) }
    func consent(_ sid: String, accepted: Bool) async throws {
        struct Body: Encodable { var accepted: Bool; var consentVersion = "v1"; var routeSharingAfterRound: Bool; var guestDisclosureAcknowledged: Bool }
        let _: OkResponse = try await post("/v1/sessions/\(sid)/consent", Body(accepted: accepted, routeSharingAfterRound: accepted, guestDisclosureAcknowledged: accepted))
    }
    func setReady(_ sid: String, ready: Bool, preflight: HealthPayload) async throws {
        struct Body: Encodable { var ready: Bool; var preflight: HealthPayload }
        let _: OkResponse = try await post("/v1/sessions/\(sid)/ready", Body(ready: ready, preflight: preflight))
    }
    func startRound(_ sid: String, _ rid: String, acknowledgeWarnings: Bool) async throws {
        struct Body: Encodable { var acknowledgeWarnings: Bool }
        let _: OkResponse = try await post("/v1/sessions/\(sid)/rounds/\(rid)/start", Body(acknowledgeWarnings: acknowledgeWarnings))
    }
    func pause(_ sid: String, _ rid: String, safety: Bool, reason: String?) async throws {
        struct Body: Encodable { var kind: String; var reason: String? }
        let _: EmptyBody = try await post("/v1/sessions/\(sid)/rounds/\(rid)/pause", Body(kind: safety ? "SAFETY" : "MANUAL", reason: reason))
    }
    func resume(_ sid: String, _ rid: String) async throws { let _: EmptyBody = try await post("/v1/sessions/\(sid)/rounds/\(rid)/resume") }
    func abort(_ sid: String, _ rid: String, reason: String, safety: Bool) async throws {
        struct Body: Encodable { var reason: String; var safety: Bool }
        let _: EmptyBody = try await post("/v1/sessions/\(sid)/rounds/\(rid)/abort", Body(reason: reason, safety: safety))
    }
    func uploadLocations(_ sid: String, _ rid: String, _ body: LocationBatchBody) async throws -> LocationBatchResponse {
        // The batch id doubles as the idempotency key: retries never duplicate samples.
        var data = try JSONCoding.encoder.encode(body)
        var headers: [String: String] = [:]
        // Backlogs after an outage compress ~5×; small routine batches aren't worth it.
        if data.count > 4096, let gz = Gzip.compress(data) {
            data = gz
            headers["Content-Encoding"] = "gzip"
        }
        let (resp, _) = try await raw("POST", "/v1/sessions/\(sid)/rounds/\(rid)/location-batches", body: data, contentType: "application/json", idempotencyKey: body.batchId, headers: headers)
        return try decode(resp)
    }
    func myTrack(_ sid: String, _ rid: String) async throws -> MyTrack { try await get("/v1/sessions/\(sid)/rounds/\(rid)/my-track") }
    func captureInit(_ sid: String, _ rid: String) async throws -> CaptureTicket { try await post("/v1/sessions/\(sid)/rounds/\(rid)/captures/init") }
    func capturePhoto(path: String, jpeg: Data) async throws {
        _ = try await raw("PUT", path, body: jpeg, contentType: "image/jpeg", idempotencyKey: UUID().uuidString)
    }
    func captureComplete(_ sid: String, _ rid: String, claimId: String) async throws {
        struct Body: Encodable { var claimId: String }
        let data = try JSONCoding.encoder.encode(Body(claimId: claimId))
        _ = try await raw("POST", "/v1/sessions/\(sid)/rounds/\(rid)/captures/complete", body: data, contentType: "application/json", idempotencyKey: "complete-\(claimId)")
    }
    func decide(_ sid: String, _ rid: String, claimId: String, confirm: Bool, reason: String?) async throws {
        struct Body: Encodable { var decision: String; var reason: String? }
        let _: EmptyBody = try await post("/v1/sessions/\(sid)/rounds/\(rid)/captures/\(claimId)/decision", Body(decision: confirm ? "CONFIRM" : "REJECT", reason: reason))
    }
    func dispute(_ sid: String, _ rid: String, claimId: String, accept: Bool) async throws {
        struct Body: Encodable { var resolution: String }
        let _: EmptyBody = try await post("/v1/sessions/\(sid)/rounds/\(rid)/captures/\(claimId)/dispute", Body(resolution: accept ? "ACCEPT_AS_CATCH" : "KEEP_REJECTED"))
    }
    func photo(path: String) async throws -> Data { try await raw("GET", path).0 }
    /// Sets up the next round, or re-targets a READY one (who hides, together or race).
    func nextRound(_ sid: String, hidingTeam: TeamKey? = nil, seekMode: SeekMode? = nil) async throws -> SessionViewDoc {
        struct Body: Encodable { var hidingTeam: TeamKey?; var seekMode: SeekMode? }
        return try await post("/v1/sessions/\(sid)/next-round", Body(hidingTeam: hidingTeam, seekMode: seekMode))
    }
    func completeSession(_ sid: String) async throws { let _: OkResponse = try await post("/v1/sessions/\(sid)/complete") }
    func keepPhotos(_ sid: String, keep: Bool) async throws {
        struct Body: Encodable { var keep: Bool }
        let _: EmptyBody = try await post("/v1/sessions/\(sid)/keep-photos", Body(keep: keep))
    }
    func deleteSession(_ sid: String) async throws { let _: EmptyBody = try await delete("/v1/sessions/\(sid)") }
    func deleteMyData(_ sid: String) async throws -> DeleteMyDataResponse { try await delete("/v1/sessions/\(sid)/my-data") }

    // Recap / analytics
    func summary(_ sid: String, _ rid: String) async throws -> RoundSummary { try await get("/v1/sessions/\(sid)/rounds/\(rid)/summary") }
    func routes(_ sid: String, _ rid: String) async throws -> RouteRecap { try await get("/v1/sessions/\(sid)/rounds/\(rid)/routes") }
    func analytics(_ sid: String) async throws -> SessionAnalytics { try await get("/v1/sessions/\(sid)/analytics") }
    func personAnalytics(_ personId: String) async throws -> PersonAnalyticsResponse { try await get("/v1/analytics/people/\(personId)") }
    func export(_ sid: String, format: String) async throws -> Data { try await raw("GET", "/v1/export/sessions/\(sid).\(format)").0 }

    // Friends
    func friends() async throws -> FriendsResponse { try await get("/v1/friends") }
    func friendRequests() async throws -> FriendRequestsResponse { try await get("/v1/friends/requests") }
    func sendFriendRequest(handle: String? = nil, token: String? = nil) async throws -> FriendRequestResult {
        struct Body: Encodable { var handle: String?; var inviteToken: String? }
        return try await post("/v1/friends/requests", Body(handle: handle, inviteToken: token))
    }
    func respondFriendRequest(_ id: String, accept: Bool) async throws {
        struct Body: Encodable { var accept: Bool }
        let _: FriendRequestResult = try await post("/v1/friends/requests/\(id)/respond", Body(accept: accept))
    }
    func removeFriend(_ uid: String) async throws { let _: OkResponse = try await delete("/v1/friends/\(uid)") }
    func block(_ uid: String) async throws { let _: OkResponse = try await post("/v1/friends/\(uid)/block") }
    func unblock(_ uid: String) async throws { let _: OkResponse = try await delete("/v1/blocks/\(uid)") }

    // People & groups
    func people(query: String? = nil) async throws -> PeopleResponse {
        try await get("/v1/people", query: query.map { [URLQueryItem(name: "q", value: $0)] } ?? [])
    }
    func createPerson(name: String, confirmNew: Bool) async throws -> CreatePersonResponse {
        struct Body: Encodable { var displayName: String; var confirmNew: Bool }
        return try await post("/v1/people", Body(displayName: name, confirmNew: confirmNew))
    }
    func renamePerson(_ id: String, name: String) async throws -> Person {
        struct Body: Encodable { var displayName: String }
        return try await patch("/v1/people/\(id)", Body(displayName: name))
    }
    func mergePerson(_ id: String, into: String) async throws {
        struct Body: Encodable { var intoPersonId: String }
        let _: EmptyBody = try await post("/v1/people/\(id)/merge", Body(intoPersonId: into))
    }
    func requestPersonLink(_ id: String) async throws { let _: FriendRequestResult = try await post("/v1/people/\(id)/link-requests") }
    func linkRequests() async throws -> LinkRequestsResponse { try await get("/v1/people/link-requests") }
    func respondLink(_ id: String, approve: Bool) async throws {
        struct Body: Encodable { var approve: Bool }
        let _: FriendRequestResult = try await post("/v1/people/link-requests/\(id)/respond", Body(approve: approve))
    }
    func groups() async throws -> GroupsResponse { try await get("/v1/groups") }
    func createGroup(name: String, personIds: [String], memberUids: [String]) async throws -> IdResponse {
        struct Body: Encodable { var name: String; var personIds: [String]; var memberUids: [String] }
        return try await post("/v1/groups", Body(name: name, personIds: personIds, memberUids: memberUids))
    }
    func updateGroup(_ id: String, name: String?, personIds: [String]?, memberUids: [String]?) async throws {
        struct Body: Encodable { var name: String?; var personIds: [String]?; var memberUids: [String]? }
        let _: OkResponse = try await patch("/v1/groups/\(id)", Body(name: name, personIds: personIds, memberUids: memberUids))
    }
    func deleteGroup(_ id: String) async throws { let _: OkResponse = try await delete("/v1/groups/\(id)") }
}
