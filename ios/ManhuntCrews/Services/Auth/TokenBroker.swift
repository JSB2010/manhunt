import Foundation
import FirebaseAuth

/// One Firebase ID token for every API request.
///
/// Refreshes are single-flight: however many requests (or 401s) arrive at once,
/// Firebase sees one refresh. A burst of forced refreshes when the token expires
/// is exactly what Firebase throttles as "too many requests". Expiry is judged on
/// the server clock, so a phone whose clock is minutes off still refreshes before
/// the server starts rejecting its token.
actor TokenBroker {
    typealias Fetch = @Sendable (_ forceRefresh: Bool) async throws -> String

    /// Refresh this long before expiry (Firebase's own margin, measured on server time).
    static let refreshMargin: TimeInterval = 5 * 60
    /// A cached token this close to expiry is not worth sending.
    static let minimumValidity: TimeInterval = 30
    /// Never force a proactive refresh more often than this (guards a bad clock estimate).
    static let proactiveInterval: TimeInterval = 60
    static let throttleBackoff: (base: TimeInterval, max: TimeInterval) = (5, 120)

    private let fetch: Fetch
    private let now: @Sendable () -> Date
    private var cached: (token: String, expiry: Date)?
    /// Most recent token handed out, even when its expiry can't be read.
    private var latest: String?
    private var inFlight: (id: Int, task: Task<String, Error>)?
    private var nextId = 0
    /// Bumped by `reset()`: refreshes started before it end in `CancellationError`,
    /// never in a token (or an `.unauthenticated`) for the account that came after.
    private var generation = 0
    private var lastProactiveForce: Date?
    private var throttledUntil: Date?
    private var throttleStrikes = 0
    private var scheduled: Task<Void, Never>?

    init(fetch: @escaping Fetch, now: @escaping @Sendable () -> Date = { ServerClock.shared.now() }) {
        self.fetch = fetch
        self.now = now
    }

    /// A token for the next request. Transient refresh failures fall back to the
    /// cached token while the server would still accept it.
    func token() async throws -> String {
        if let c = cached, c.expiry.timeIntervalSince(now()) > Self.refreshMargin { return c.token }
        do {
            let t = try await refresh(force: false)
            // Firebase checks expiry against the device clock; on server time this one may be nearly done.
            if let exp = JWT.expiry(of: t), exp.timeIntervalSince(now()) <= Self.refreshMargin,
               lastProactiveForce.map({ now().timeIntervalSince($0) > Self.proactiveInterval }) ?? true {
                lastProactiveForce = now()
                return try await refresh(force: true)
            }
            return t
        } catch let e as APIError where e != .unauthenticated {
            if let c = cached, c.expiry.timeIntervalSince(now()) > Self.minimumValidity { return c.token }
            throw e
        }
    }

    /// The server answered 401 to `rejected`. Every request that saw the same
    /// rejection shares one forced refresh; a request whose token was already
    /// replaced just uses the new one.
    func tokenAfterRejection(of rejected: String) async throws -> String {
        if let inFlight {
            let t = try await inFlight.task.value
            if t != rejected { return t }
        }
        if let latest, latest != rejected { return latest }
        return try await refresh(force: true)
    }

    /// On foreground: get a fresh token before the first request needs one.
    func refreshIfNeeded() async {
        _ = try? await token()
    }

    /// Sign-out (or a different account): forget everything, drop refreshes in flight.
    func reset() {
        generation += 1
        cached = nil
        latest = nil
        inFlight = nil
        lastProactiveForce = nil
        throttledUntil = nil
        throttleStrikes = 0
        scheduled?.cancel()
        scheduled = nil
    }

    // MARK: Refresh

    private func refresh(force: Bool) async throws -> String {
        if let inFlight { return try await inFlight.task.value }
        if let until = throttledUntil {
            let wait = until.timeIntervalSince(now())
            if wait > 0 { throw APIError.rateLimited(retryAfter: wait) }
        }
        nextId += 1
        let id = nextId
        let gen = generation
        let task = Task { try await self.perform(force: force, generation: gen) }
        inFlight = (id, task)
        defer { if inFlight?.id == id { inFlight = nil } }
        return try await task.value
    }

    private func perform(force: Bool, generation gen: Int) async throws -> String {
        let result: Result<String, Error>
        do { result = .success(try await fetch(force)) } catch { result = .failure(error) }
        guard gen == generation else { throw CancellationError() }
        switch result {
        case let .success(t):
            accept(t)
            return t
        case let .failure(error):
            let mapped = TokenErrorMapping.map(error)
            switch mapped {
            case .rateLimited:
                throttleStrikes += 1
                let wait = min(Self.throttleBackoff.max, Self.throttleBackoff.base * pow(2, Double(throttleStrikes - 1)))
                throttledUntil = now().addingTimeInterval(wait)
                throw APIError.rateLimited(retryAfter: wait)
            case .unauthenticated:
                cached = nil
                latest = nil
                throw mapped
            default:
                throw mapped
            }
        }
    }

    private func accept(_ t: String) {
        latest = t
        throttledUntil = nil
        throttleStrikes = 0
        guard let exp = JWT.expiry(of: t) else {
            cached = nil
            return
        }
        cached = (t, exp)
        scheduleRefresh(before: exp)
    }

    /// Wake shortly inside the refresh margin so the next request finds a fresh token.
    private func scheduleRefresh(before expiry: Date) {
        scheduled?.cancel()
        let delay = expiry.timeIntervalSince(now()) - Self.refreshMargin + 10
        guard delay > 0 else { return }
        scheduled = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.refreshIfNeeded()
        }
    }
}

/// What a token-fetch failure means for the session. Only a definitive answer
/// from Firebase (refresh token revoked or expired, account disabled or deleted,
/// nobody signed in) ends it; a flaky network or Firebase throttling must never
/// sign anyone out mid-game.
enum TokenErrorMapping {
    static let definitive: Set<Int> = [
        AuthErrorCode.userTokenExpired.rawValue,
        AuthErrorCode.invalidUserToken.rawValue,
        AuthErrorCode.userDisabled.rawValue,
        AuthErrorCode.userNotFound.rawValue,
        AuthErrorCode.nullUser.rawValue,
    ]

    static func map(_ error: Error) -> APIError {
        if let e = error as? APIError { return e }
        let ns = error as NSError
        if ns.domain == AuthErrors.domain {
            if definitive.contains(ns.code) { return .unauthenticated }
            if ns.code == AuthErrorCode.tooManyRequests.rawValue { return .rateLimited(retryAfter: nil) }
        }
        // Network errors, keychain hiccups, anything unrecognised: transient.
        return .offline(ns.localizedDescription)
    }
}

/// Reads claims from a JWT payload. No signature check: only used to schedule refreshes.
enum JWT {
    static func expiry(of token: String) -> Date? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = (claims["exp"] as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: exp)
    }
}
