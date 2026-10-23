import XCTest
import FirebaseAuth
@testable import ManhuntCrews

// MARK: Fakes

/// JWT-shaped token expiring at `exp`; only the payload matters to the app.
private func fakeJWT(exp: Date, tag: String = UUID().uuidString) -> String {
    let payload = try! JSONSerialization.data(withJSONObject: ["exp": exp.timeIntervalSince1970, "tag": tag])
    let b64 = payload.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return "eyJhbGciOiJub25lIn0.\(b64).sig"
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
}

/// Stands in for Firebase's `getIDToken`: records every fetch, answers after a short delay
/// so concurrent callers overlap.
private final class FakeTokenSource: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [Bool] = []
    private var respond: (_ force: Bool) throws -> String
    init(_ respond: @escaping (_ force: Bool) throws -> String) { self.respond = respond }

    var count: Int { lock.withLock { calls.count } }
    var forcedCount: Int { lock.withLock { calls.filter { $0 }.count } }
    func answer(_ respond: @escaping (_ force: Bool) throws -> String) { lock.withLock { self.respond = respond } }

    func fetch(_ force: Bool) async throws -> String {
        let respond = lock.withLock { calls.append(force); return self.respond }
        try await Task.sleep(nanoseconds: 50_000_000)
        return try respond(force)
    }
}

private func authError(_ code: AuthErrorCode) -> NSError { NSError(domain: AuthErrors.domain, code: code.rawValue) }

/// In-process HTTP server: each test registers a handler for its own host.
final class StubProtocol: URLProtocol {
    struct Reply {
        var status: Int
        var headers: [String: String] = [:]
        var body = Data()
        static func json(_ status: Int, _ object: Any, headers: [String: String] = [:]) -> Reply {
            Reply(status: status, headers: headers.merging(["Content-Type": "application/json"]) { a, _ in a }, body: try! JSONSerialization.data(withJSONObject: object))
        }
        static func error(_ status: Int, _ code: String, details: [String: Any]? = nil, headers: [String: String] = [:]) -> Reply {
            .json(status, ["error": ["code": code, "message": code, "details": details.map { $0 as Any } ?? NSNull()], "requestId": "r"], headers: headers)
        }
    }

    private static let lock = NSLock()
    /// Handler gets the request and its 1-based number for that host.
    private static var handlers: [String: (URLRequest, Int) -> Reply] = [:]
    private static var log: [String: [URLRequest]] = [:]

    static func register(_ host: String, _ handler: @escaping (URLRequest, Int) -> Reply) { lock.withLock { handlers[host] = handler } }
    static func requests(_ host: String) -> [URLRequest] { lock.withLock { log[host] ?? [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let host = request.url?.host ?? ""
        let (handler, n) = Self.lock.withLock { () -> (((URLRequest, Int) -> Reply)?, Int) in
            Self.log[host, default: []].append(request)
            return (Self.handlers[host], Self.log[host]!.count)
        }
        let reply = handler?(request, n) ?? Reply(status: 599)
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func stubbedClient(_ handler: @escaping (URLRequest, Int) -> StubProtocol.Reply) -> (APIClient, String) {
    let host = "stub-\(UUID().uuidString.prefix(8).lowercased()).test"
    StubProtocol.register(host, handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubProtocol.self]
    return (APIClient(baseURL: URL(string: "https://\(host)")!, clock: ServerClock(), configuration: cfg), host)
}

private func concurrently<T: Sendable>(_ n: Int, _ op: @escaping @Sendable () async throws -> T) async throws -> [T] {
    try await withThrowingTaskGroup(of: T.self) { group in
        for _ in 0..<n { group.addTask { try await op() } }
        return try await group.reduce(into: []) { $0.append($1) }
    }
}

// MARK: Token broker

final class TokenBrokerTests: XCTestCase {
    func testConcurrentRequestsShareOneRefresh() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { _ in fakeJWT(exp: clock.now.addingTimeInterval(3600)) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        let tokens = try await concurrently(25) { try await broker.token() }
        XCTAssertEqual(Set(tokens).count, 1)
        XCTAssertEqual(src.count, 1)
        _ = try await broker.token()
        XCTAssertEqual(src.count, 1, "a fresh token is reused, not refetched")
    }

    func testConcurrent401sShareOneForcedRefresh() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { force in fakeJWT(exp: clock.now.addingTimeInterval(3600), tag: force ? "new" : "old") }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        let rejected = try await broker.token()
        let fresh = try await concurrently(25) { try await broker.tokenAfterRejection(of: rejected) }
        XCTAssertEqual(src.forcedCount, 1, "one forced refresh however many requests saw the 401")
        XCTAssertEqual(Set(fresh).count, 1)
        XCTAssertNotEqual(fresh.first, rejected)
        // A straggler 401 for the old token uses the new one instead of refreshing again.
        _ = try await broker.tokenAfterRejection(of: rejected)
        XCTAssertEqual(src.forcedCount, 1)
    }

    func testRefreshesBeforeExpiryMeasuredOnServerTime() async throws {
        let clock = TestClock()
        // Firebase (device clock behind) still considers its 4-minute token fine.
        let src = FakeTokenSource { force in fakeJWT(exp: clock.now.addingTimeInterval(force ? 3600 : 240)) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        let t = try await broker.token()
        XCTAssertEqual(src.forcedCount, 1, "forced because it expires within 5 minutes of server time")
        XCTAssertEqual(JWT.expiry(of: t), clock.now.addingTimeInterval(3600))
        _ = try await broker.token()
        XCTAssertEqual(src.count, 2)
        clock.advance(56 * 60)
        _ = try await broker.token()
        XCTAssertEqual(src.forcedCount, 2, "refreshed again once inside the 5-minute margin")
    }

    func testTransientFailureKeepsUsingAStillValidToken() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { _ in fakeJWT(exp: clock.now.addingTimeInterval(600)) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        let t = try await broker.token()
        clock.advance(6 * 60) // 4 minutes left: wants a refresh
        src.answer { _ in throw URLError(.notConnectedToInternet) }
        let again = try await broker.token()
        XCTAssertEqual(again, t, "offline: keep playing on the token the server still accepts")
        clock.advance(4 * 60 - 10) // 10 s left: not worth sending
        do {
            _ = try await broker.token()
            XCTFail("expected offline")
        } catch let e as APIError {
            guard case .offline = e else { return XCTFail("got \(e)") }
        }
    }

    func testThrottlingBacksOffWithoutHammeringFirebase() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { _ in throw authError(.tooManyRequests) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        do {
            _ = try await broker.token()
            XCTFail("expected rate limit")
        } catch let e as APIError {
            XCTAssertEqual(e, .rateLimited(retryAfter: 5))
        }
        for _ in 0..<5 {
            do { _ = try await broker.token(); XCTFail("expected rate limit") } catch let e as APIError {
                guard case .rateLimited = e else { return XCTFail("got \(e)") }
            }
        }
        XCTAssertEqual(src.count, 1, "no calls to Firebase while backing off")
        clock.advance(6)
        src.answer { _ in fakeJWT(exp: clock.now.addingTimeInterval(3600)) }
        _ = try await broker.token()
        XCTAssertEqual(src.count, 2)
    }

    func testDefinitiveFailureEndsTheSession() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { _ in fakeJWT(exp: clock.now.addingTimeInterval(600)) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        _ = try await broker.token()
        clock.advance(6 * 60)
        src.answer { _ in throw authError(.userTokenExpired) }
        do {
            _ = try await broker.token()
            XCTFail("expected unauthenticated")
        } catch let e as APIError {
            XCTAssertEqual(e, .unauthenticated, "a revoked refresh token is not papered over with the cached token")
        }
    }

    func testResetForgetsTheAccount() async throws {
        let clock = TestClock()
        let src = FakeTokenSource { _ in fakeJWT(exp: clock.now.addingTimeInterval(3600)) }
        let broker = TokenBroker(fetch: src.fetch, now: { clock.now })
        let before = try await broker.token()
        await broker.reset()
        let after = try await broker.token()
        XCTAssertEqual(src.count, 2)
        XCTAssertNotEqual(before, after)
    }

    func testOnlyDefinitiveFirebaseErrorsMapToUnauthenticated() {
        for code in [AuthErrorCode.userTokenExpired, .invalidUserToken, .userDisabled, .userNotFound, .nullUser] {
            XCTAssertEqual(TokenErrorMapping.map(authError(code)), .unauthenticated, "\(code)")
        }
        XCTAssertEqual(TokenErrorMapping.map(authError(.tooManyRequests)), .rateLimited(retryAfter: nil))
        for error in [authError(.networkError), authError(.internalError), authError(.keychainError), URLError(.timedOut) as Error, URLError(.notConnectedToInternet)] {
            guard case .offline = TokenErrorMapping.map(error) else { return XCTFail("\(error) must be transient") }
        }
        XCTAssertEqual(TokenErrorMapping.map(APIError.unauthenticated), .unauthenticated)
    }

    /// 2026-10-22: the "Can't Reach the Game Server" screen showed Firebase's developer text.
    func testTransientErrorsReadAsPlainWords() {
        let internalError = NSError(domain: AuthErrors.domain, code: AuthErrorCode.internalError.rawValue, userInfo: [NSLocalizedDescriptionKey: "An internal error has occurred, print and inspect the error details for more information."])
        let shown = TokenErrorMapping.map(internalError).localizedDescription
        XCTAssertFalse(shown.contains("inspect the error details"), shown)
        XCTAssertTrue(shown.hasPrefix("No connection to the game server."), shown)
        // Network errors keep the system's own wording.
        let offline = URLError(.notConnectedToInternet)
        XCTAssertTrue(TokenErrorMapping.map(offline).localizedDescription.contains(offline.localizedDescription))
    }
}

// MARK: Retry policy and 429 handling

final class RetryPolicyTests: XCTestCase {
    func testRateLimitWaitsAtLeastRetryAfterWithJitter() {
        XCTAssertEqual(RetryPolicy.delay(for: .rateLimited(retryAfter: 2), attempt: 1, random: 0), 2)
        XCTAssertEqual(RetryPolicy.delay(for: .rateLimited(retryAfter: 2), attempt: 1, random: 1), 3)
        XCTAssertEqual(RetryPolicy.delay(for: .rateLimited(retryAfter: nil), attempt: 1, random: 0), 2)
        XCTAssertEqual(RetryPolicy.delay(for: .rateLimited(retryAfter: nil), attempt: 2, random: 0), 4)
        XCTAssertNil(RetryPolicy.delay(for: .rateLimited(retryAfter: 120), attempt: 1, random: 0), "a long ask is not retried")
    }

    func testOtherRetriesBackOffExponentiallyWithJitter() {
        let a = RetryPolicy.delay(for: .offline("x"), attempt: 1, random: 0)!
        let b = RetryPolicy.delay(for: .offline("x"), attempt: 1, random: 1)!
        XCTAssertLessThan(a, b)
        XCTAssertGreaterThan(RetryPolicy.delay(for: .offline("x"), attempt: 2, random: 0)!, a)
        XCTAssertNil(RetryPolicy.delay(for: .unauthenticated, attempt: 1))
        XCTAssertNil(RetryPolicy.delay(for: .server(status: 409, code: "STALE_PHASE", message: "", details: nil), attempt: 1))
        XCTAssertEqual(RetryPolicy.delay(for: .server(status: 429, code: "HTTP_429", message: "", details: nil), attempt: 1, random: 0), 2, "any 429 backs off like a rate limit")
    }

    func testParsesRetryAfter() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(RetryPolicy.retryAfter(header: "3", bodySeconds: nil), 3)
        XCTAssertEqual(RetryPolicy.retryAfter(header: nil, bodySeconds: 7), 7)
        XCTAssertNil(RetryPolicy.retryAfter(header: "soon", bodySeconds: nil))
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        XCTAssertEqual(RetryPolicy.retryAfter(header: f.string(from: now.addingTimeInterval(30)), bodySeconds: nil, now: now) ?? 0, 30, accuracy: 1)
    }
}

final class APIClientResilienceTests: XCTestCase {
    private func bearer(_ req: URLRequest) -> String? { req.value(forHTTPHeaderField: "Authorization") }

    func testHonoursRetryAfterThenSucceeds() async throws {
        let (api, host) = stubbedClient { _, n in
            n == 1 ? .error(429, "RATE_LIMITED", details: ["retryAfterSeconds": 1], headers: ["Retry-After": "1"]) : .json(200, [:])
        }
        let started = Date()
        let _: EmptyBody = try await api.post("/v1/sessions/s1/ready")
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertEqual(StubProtocol.requests(host).count, 2)
        XCTAssertGreaterThanOrEqual(elapsed, 1, "waited at least Retry-After")
        XCTAssertLessThan(elapsed, 4)
    }

    func testLongRetryAfterFailsFastAndHoldsBackLaterCalls() async throws {
        let (api, host) = stubbedClient { req, _ in
            req.url!.path.hasSuffix("/invites") ? .error(429, "RATE_LIMITED", details: ["retryAfterSeconds": 120], headers: ["Retry-After": "120"]) : .json(200, [:])
        }
        do {
            let _: EmptyBody = try await api.post("/v1/sessions/s1/invites")
            XCTFail("expected rate limit")
        } catch let e as APIError {
            XCTAssertEqual(e, .rateLimited(retryAfter: 120))
            XCTAssertEqual(e.code, "RATE_LIMITED")
        }
        XCTAssertEqual(StubProtocol.requests(host).count, 1, "no immediate retry")
        do {
            let _: EmptyBody = try await api.post("/v1/sessions/s1/invites")
            XCTFail("expected rate limit")
        } catch let e as APIError {
            guard case let .rateLimited(retryAfter) = e else { return XCTFail("got \(e)") }
            XCTAssertGreaterThan(retryAfter ?? 0, 100)
        }
        XCTAssertEqual(StubProtocol.requests(host).count, 1, "the cool-down holds the endpoint without touching the network")
        let _: EmptyBody = try await api.post("/v1/sessions/s1/ready")
        XCTAssertEqual(StubProtocol.requests(host).count, 2, "other endpoints are not held")
    }

    func testPlainCloudRun429IsARetryableRateLimit() async throws {
        let (api, host) = stubbedClient { _, n in
            n == 1 ? .init(status: 429, headers: ["Retry-After": "0"], body: Data("Rate exceeded.".utf8)) : .json(200, [:])
        }
        do {
            try await api.raw("GET", "/v1/me")
            XCTFail("expected rate limit")
        } catch let e as APIError {
            XCTAssertEqual(e, .rateLimited(retryAfter: 0))
            XCTAssertTrue(e.isRetryable)
        }
        let _: EmptyBody = try await api.get("/v1/me")
        XCTAssertEqual(StubProtocol.requests(host).count, 2)
    }

    func testConcurrent401sTriggerOneForcedRefresh() async throws {
        let src = FakeTokenSource { force in fakeJWT(exp: Date().addingTimeInterval(3600), tag: force ? "new" : "old") }
        let (api, host) = stubbedClient { req, _ in
            let auth = req.value(forHTTPHeaderField: "Authorization") ?? ""
            let payload = auth.split(separator: ".").dropFirst().first.map(String.init) ?? ""
            return Self.tag(of: payload) == "new" ? .json(200, [:]) : .error(401, "UNAUTHENTICATED")
        }
        api.tokenProvider = { force in try await src.fetch(force) }
        let results = try await concurrently(20) { () -> Bool in
            let _: EmptyBody = try await api.get("/v1/me")
            return true
        }
        XCTAssertEqual(results.count, 20)
        XCTAssertEqual(src.forcedCount, 1, "20 simultaneous 401s, one refresh")
        XCTAssertEqual(src.count, 2)
        // Each request: the stale token's 401, then the retry (a straggler may start with the new one).
        XCTAssertTrue((39...40).contains(StubProtocol.requests(host).count))
    }

    func testRepeated401IsUnauthenticated() async throws {
        let src = FakeTokenSource { _ in fakeJWT(exp: Date().addingTimeInterval(3600)) }
        let (api, host) = stubbedClient { _, _ in .error(401, "UNAUTHENTICATED") }
        api.tokenProvider = { force in try await src.fetch(force) }
        do {
            let _: EmptyBody = try await api.get("/v1/me")
            XCTFail("expected unauthenticated")
        } catch let e as APIError {
            XCTAssertEqual(e, .unauthenticated)
        }
        XCTAssertEqual(StubProtocol.requests(host).count, 2, "one retry with a fresh token, then give up")
    }

    func testTokenFetchFailuresDoNotLookLikeSignedOut() async throws {
        let src = FakeTokenSource { _ in throw URLError(.notConnectedToInternet) }
        let (api, host) = stubbedClient { _, _ in .json(200, [:]) }
        api.tokenProvider = { force in try await src.fetch(force) }
        do {
            let _: EmptyBody = try await api.get("/v1/me")
            XCTFail("expected offline")
        } catch let e as APIError {
            guard case .offline = e else { return XCTFail("got \(e)") }
        }
        src.answer { _ in throw authError(.tooManyRequests) }
        do {
            try await api.raw("GET", "/v1/me")
            XCTFail("expected rate limit")
        } catch let e as APIError {
            guard case .rateLimited = e else { return XCTFail("got \(e)") }
        }
        XCTAssertEqual(StubProtocol.requests(host).count, 0)
    }

    func testTimeSyncSendsNoToken() async throws {
        let src = FakeTokenSource { _ in fakeJWT(exp: Date().addingTimeInterval(3600)) }
        let (api, host) = stubbedClient { _, _ in .json(200, ["serverTime": "2026-10-18T20:00:00.000Z"]) }
        api.tokenProvider = { force in try await src.fetch(force) }
        await api.syncTime()
        let reqs = StubProtocol.requests(host)
        XCTAssertEqual(reqs.map { $0.url!.path }, ["/v1/time"])
        XCTAssertNil(reqs.first.flatMap(bearer))
        XCTAssertEqual(src.count, 0)
    }

    private static func tag(of payloadB64: String) -> String? {
        var b64 = payloadB64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["tag"] as? String
    }
}

// MARK: Sign-out

@MainActor
final class SignOutTests: XCTestCase {
    private static let expired = "Your session expired — please sign in again."

    /// An AppModel whose API answers 401 to everything, with Firebase reporting nobody signed in.
    private func makeModel() async throws -> (AppModel, String) {
        try? Auth.auth().signOut()
        let (api, host) = stubbedClient { _, _ in .error(401, "UNAUTHENTICATED") }
        let model = AppModel(env: .current, api: api)
        api.tokenProvider = { _ in fakeJWT(exp: Date().addingTimeInterval(3600)) }
        // Let the Firebase listener report "signed out" before the test drives the state.
        for _ in 0..<300 where model.auth.state == .unknown { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(model.auth.state, .signedOut)
        return (model, host)
    }

    func testVoluntarySignOutNeverRefreshesOrSaysExpired() async throws {
        let (model, host) = try await makeModel()
        model.auth.state = .signedIn(uid: "u-voluntary", email: nil)
        await model.signOut()
        try await Task.sleep(nanoseconds: 400_000_000) // any stray refresh would have landed by now
        XCTAssertNil(model.toast)
        XCTAssertNil(model.auth.uid)
        XCTAssertEqual(StubProtocol.requests(host).count, 0, "signing out must not call the API")
        await model.refreshMe()
        model.closeSession()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertNil(model.toast)
        XCTAssertEqual(StubProtocol.requests(host).count, 0, "signed out: nothing to refresh")
    }

    func testExpiredSessionSignsOutOnceWithOneNotice() async throws {
        let (model, host) = try await makeModel()
        model.auth.state = .signedIn(uid: "u-expired", email: nil)
        async let a: Void = model.refreshMe()
        async let b: Void = model.refreshMe()
        async let c: Void = model.refreshMe()
        _ = await (a, b, c)
        XCTAssertEqual(model.toast, Self.expired)
        XCTAssertNil(model.auth.uid)
        XCTAssertNil(model.me)
        let sent = StubProtocol.requests(host).count
        XCTAssertLessThanOrEqual(sent, 6, "each refresh: one 401 and one retry at most")

        model.toast = nil
        await model.refreshMe()
        model.closeSession()
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertNil(model.toast, "no second notice")
        XCTAssertEqual(StubProtocol.requests(host).count, sent, "no refresh loop after signing out")
    }

    func testSignOutIsNotReentrant() async throws {
        let (model, host) = try await makeModel()
        model.auth.state = .signedIn(uid: "u-twice", email: nil)
        async let a: Void = model.signOut(reason: .sessionExpired)
        async let b: Void = model.signOut(reason: .sessionExpired)
        _ = await (a, b)
        XCTAssertEqual(model.toast, Self.expired)
        XCTAssertEqual(StubProtocol.requests(host).count, 0)
    }
}
