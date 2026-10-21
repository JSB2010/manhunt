import Foundation

/// Typed errors from spec §10.3 plus transport failures.
enum APIError: Error, LocalizedError, Equatable {
    case server(status: Int, code: String, message: String, details: ErrorDetails?)
    case offline(String)
    case unauthenticated
    /// HTTP 429 (our RATE_LIMITED or Cloud Run's plain one) or Firebase token
    /// throttling. `retryAfter` is the server's ask, in seconds, when it gave one.
    case rateLimited(retryAfter: TimeInterval?)
    case decoding(String)
    case invalidResponse

    var code: String? {
        switch self {
        case let .server(_, code, _, _): return code
        case .rateLimited: return "RATE_LIMITED"
        default: return nil
        }
    }

    var isRetryable: Bool {
        switch self {
        case .offline, .rateLimited: return true
        case let .server(status, code, _, _): return status >= 500 || status == 429 || code == "RETRYABLE_TEMPORARY" || code == "RATE_LIMITED"
        default: return false
        }
    }

    /// The server's wait for a rate limit (`.some(nil)`: limited, no wait given); nil if not rate limited.
    var rateLimitWait: TimeInterval?? {
        switch self {
        case let .rateLimited(retryAfter): return .some(retryAfter)
        case let .server(status, code, _, details) where status == 429 || code == "RATE_LIMITED": return .some(details?.retryAfterSeconds)
        default: return nil
        }
    }

    /// The server itself asked us to wait (429 / 503), as opposed to no connection.
    var isServerBackoff: Bool {
        switch self {
        case .rateLimited: return true
        case let .server(status, code, _, _): return status == 429 || status == 503 || code == "RETRYABLE_TEMPORARY" || code == "RATE_LIMITED"
        default: return false
        }
    }

    var errorDescription: String? {
        switch self {
        case let .server(_, code, message, _):
            switch code {
            case "GAME_NOT_READY", "STALE_PHASE", "ALREADY_CLAIMED", "CAPTURE_EXPIRED", "GPS_UNAVAILABLE", "PERMISSION_REQUIRED", "CONSENT_REQUIRED":
                return message
            default:
                return message
            }
        case let .offline(msg): return "No connection to the game server. \(msg)"
        case .unauthenticated: return "Please sign in again."
        case let .rateLimited(retryAfter):
            if let retryAfter, retryAfter >= 90 { return "Too many requests — try again in \(Int((retryAfter / 60).rounded())) minutes." }
            return "The game server is busy — try again in a moment."
        case let .decoding(msg): return "Unexpected server response (\(msg)). Update the app?"
        case .invalidResponse: return "Unexpected server response."
        }
    }
}

struct ErrorDetails: Codable, Equatable, Sendable {
    var warnings: [String]?
    var blocking: [String]?
    var issues: [Issue]?
    /// Sent with RATE_LIMITED, mirroring the Retry-After header.
    var retryAfterSeconds: Double?
    struct Issue: Codable, Equatable, Sendable { var path: String; var message: String }
}

private struct ErrorEnvelope: Decodable {
    struct Body: Decodable { var code: String; var message: String; var details: ErrorDetails? }
    var error: Body
}

/// When to try again. Retries back off exponentially with jitter so phones that
/// failed together don't retry together; a 429 waits at least as long as the
/// server asked, and a long ask is not retried at all.
enum RetryPolicy {
    /// Longest wait worth retrying (or queueing behind a cool-down) instead of failing.
    static let maxWait: TimeInterval = 20

    /// Delay before retry number `attempt` (1-based), or nil to give up. `random` in 0...1.
    static func delay(for error: APIError, attempt: Int, random: Double = .random(in: 0...1)) -> TimeInterval? {
        if let retryAfter = error.rateLimitWait {
            let base = max(retryAfter ?? 2 * pow(2, Double(attempt - 1)), 0.5)
            let d = base * (1 + 0.5 * random)
            return d <= maxWait ? d : nil
        }
        guard error.isRetryable else { return nil }
        return 0.4 * pow(2, Double(attempt)) * (0.5 + random)
    }

    /// `Retry-After` in seconds (delta-seconds or HTTP-date), else the API's `details.retryAfterSeconds`.
    static func retryAfter(header: String?, bodySeconds: Double?, now: Date = Date()) -> TimeInterval? {
        if let header = header?.trimmingCharacters(in: .whitespaces), !header.isEmpty {
            if let s = TimeInterval(header) { return max(0, s) }
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "GMT")
            f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            if let date = f.date(from: header) { return max(0, date.timeIntervalSince(now)) }
        }
        return bodySeconds.map { max(0, $0) }
    }
}

/// Cool-downs the server asked for, per endpoint (our per-bucket 429s) or for
/// everything (Cloud Run's plain 429 when every instance is busy). Calls behind
/// a short cool-down wait it out; behind a long one they fail fast — never a storm.
actor RequestThrottle {
    static let everything = "*"
    private var until: [String: Date] = [:]

    func block(_ key: String, for seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        if (until[key] ?? .distantPast) < end { until[key] = end }
    }

    /// Seconds left before `key` may be called.
    func remaining(for key: String) -> TimeInterval {
        let now = Date()
        until = until.filter { $0.value > now }
        return [until[key], until[Self.everything]].compactMap { $0?.timeIntervalSince(now) }.max() ?? 0
    }
}

/// Authenticated JSON client for the public API. Every response's server
/// time feeds `ServerClock`. State-changing calls carry an Idempotency-Key that
/// is reused across automatic retries. All requests share one `TokenBroker`.
final class APIClient: @unchecked Sendable {
    let baseURL: URL
    private let session: URLSession
    private let clock: ServerClock
    let throttle = RequestThrottle()
    private(set) var tokens: TokenBroker?
    /// Fetches a Firebase ID token; wrapped in a `TokenBroker` so refreshes are coalesced.
    var tokenProvider: (@Sendable (_ forceRefresh: Bool) async throws -> String)? {
        didSet {
            let clock = clock
            tokens = tokenProvider.map { TokenBroker(fetch: $0, now: { clock.now() }) }
        }
    }

    init(baseURL: URL, clock: ServerClock = .shared, configuration: URLSessionConfiguration = .default) {
        self.baseURL = baseURL
        self.clock = clock
        let cfg = configuration
        cfg.timeoutIntervalForRequest = 20
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        self.session = URLSession(configuration: cfg)
    }

    // MARK: JSON

    /// Reads retry once when the server asks us to wait (429/503); offline errors surface at once.
    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], retries: Int = 1) async throws -> T {
        try await withRetries(retries, when: { $0.isServerBackoff }) {
            let (data, _) = try await self.raw("GET", path, query: query)
            return try self.decode(data)
        }
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, retries: Int = 2) async throws -> T {
        let bodyData = try body.map { try JSONCoding.encoder.encode($0) }
        let key = UUID().uuidString
        return try await withRetries(retries, when: { $0.isRetryable }) {
            let (data, _) = try await self.raw(method, path, body: bodyData, contentType: bodyData == nil ? nil : "application/json", idempotencyKey: key)
            return try self.decode(data)
        }
    }

    private func withRetries<T>(_ retries: Int, when shouldRetry: (APIError) -> Bool, _ op: () async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            do {
                return try await op()
            } catch let e as APIError {
                guard attempt < retries, shouldRetry(e), let delay = RetryPolicy.delay(for: e, attempt: attempt + 1) else { throw e }
                attempt += 1
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
    }

    func post<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T { try await send("POST", path, body: body) }
    func post<T: Decodable>(_ path: String) async throws -> T { try await send("POST", path, body: EmptyBody()) }
    func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B) async throws -> T { try await send("PATCH", path, body: body) }
    func delete<T: Decodable>(_ path: String) async throws -> T { try await send("DELETE", path, body: nil as EmptyBody?, retries: 0) }

    func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONCoding.decoder.decode(T.self, from: data) } catch {
            throw APIError.decoding(String(describing: error).prefix(240).description)
        }
    }

    // MARK: Raw

    /// One request. A 401 gets one retry with a coalesced token refresh; a 429
    /// becomes `.rateLimited` and starts a cool-down that later calls respect.
    @discardableResult
    func raw(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, contentType: String? = nil, idempotencyKey: String? = nil, headers: [String: String] = [:], authenticated: Bool = true) async throws -> (Data, HTTPURLResponse) {
        let throttleKey = "\(method) \(path)"
        let wait = await throttle.remaining(for: throttleKey)
        if wait > RetryPolicy.maxWait { throw APIError.rateLimited(retryAfter: wait) }
        if wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * Double.random(in: 1...1.2) * 1_000_000_000)) }

        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.httpBody = body
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        req.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-Id")
        for (name, value) in headers { req.setValue(value, forHTTPHeaderField: name) }
        let tokens = authenticated ? self.tokens : nil
        var sentToken: String?
        if let tokens {
            let token = try await tokens.token()
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            sentToken = token
        }
        var (data, http) = try await perform(req)
        if http.statusCode == 401, let tokens, let sentToken {
            let fresh = try await tokens.tokenAfterRejection(of: sentToken)
            req.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
            (data, http) = try await perform(req)
        }
        // 304: a conditional GET whose content hasn't changed (no body).
        guard (200..<300).contains(http.statusCode) || http.statusCode == 304 else {
            let env = try? JSONCoding.decoder.decode(ErrorEnvelope.self, from: data)
            if http.statusCode == 429 {
                let retryAfter = RetryPolicy.retryAfter(header: http.value(forHTTPHeaderField: "Retry-After"), bodySeconds: env?.error.details?.retryAfterSeconds)
                // Our limiter is per endpoint bucket; a bare 429 is the platform saying "everyone wait".
                await throttle.block(env == nil ? RequestThrottle.everything : throttleKey, for: retryAfter ?? 2)
                throw APIError.rateLimited(retryAfter: retryAfter)
            }
            if let env {
                if env.error.code == "UNAUTHENTICATED" { throw APIError.unauthenticated }
                throw APIError.server(status: http.statusCode, code: env.error.code, message: env.error.message, details: env.error.details)
            }
            throw APIError.server(status: http.statusCode, code: "HTTP_\(http.statusCode)", message: "Server error \(http.statusCode)", details: nil)
        }
        return (data, http)
    }

    private func perform(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let started = ServerClock.continuousSeconds()
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.offline((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let rtt = ServerClock.continuousSeconds() - started
        if let st = http.value(forHTTPHeaderField: "x-server-time"), let date = JSONCoding.parseDate(st) {
            clock.observe(serverTime: date, rtt: rtt)
        }
        return (data, http)
    }

    /// Time sync (`GET /v1/time`): public, so it never waits on (or spends) a token refresh.
    func syncTime() async {
        _ = try? await raw("GET", "/v1/time", authenticated: false)
    }

    /// Forget the signed-in user's tokens (sign-out or account switch).
    func resetAuth() async {
        await tokens?.reset()
    }
}

struct EmptyBody: Codable, Sendable {}
