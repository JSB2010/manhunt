import Foundation

/// Typed errors from spec §10.3 plus transport failures.
enum APIError: Error, LocalizedError, Equatable {
    case server(status: Int, code: String, message: String, details: ErrorDetails?)
    case offline(String)
    case unauthenticated
    case decoding(String)
    case invalidResponse

    var code: String? {
        if case let .server(_, code, _, _) = self { return code }
        return nil
    }

    var isRetryable: Bool {
        switch self {
        case .offline: return true
        case let .server(status, code, _, _): return status >= 500 || code == "RETRYABLE_TEMPORARY" || code == "RATE_LIMITED"
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
        case let .decoding(msg): return "Unexpected server response (\(msg)). Update the app?"
        case .invalidResponse: return "Unexpected server response."
        }
    }
}

struct ErrorDetails: Codable, Equatable, Sendable {
    var warnings: [String]?
    var blocking: [String]?
    var issues: [Issue]?
    struct Issue: Codable, Equatable, Sendable { var path: String; var message: String }
}

private struct ErrorEnvelope: Decodable {
    struct Body: Decodable { var code: String; var message: String; var details: ErrorDetails? }
    var error: Body
}

/// Authenticated JSON client for the public API. Every response's server
/// time feeds `ServerClock`. State-changing calls carry an Idempotency-Key that
/// is reused across automatic retries.
final class APIClient: @unchecked Sendable {
    let baseURL: URL
    private let session: URLSession
    private let clock: ServerClock
    var tokenProvider: (@Sendable (_ forceRefresh: Bool) async throws -> String)?

    init(baseURL: URL, clock: ServerClock = .shared) {
        self.baseURL = baseURL
        self.clock = clock
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        self.session = URLSession(configuration: cfg)
    }

    // MARK: JSON

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, _) = try await raw("GET", path, query: query)
        return try decode(data)
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, retries: Int = 2) async throws -> T {
        let bodyData = try body.map { try JSONCoding.encoder.encode($0) }
        let key = UUID().uuidString
        var attempt = 0
        while true {
            do {
                let (data, _) = try await raw(method, path, body: bodyData, contentType: bodyData == nil ? nil : "application/json", idempotencyKey: key)
                return try decode(data)
            } catch let e as APIError where e.isRetryable && attempt < retries {
                attempt += 1
                try await Task.sleep(nanoseconds: UInt64(pow(2.0, Double(attempt)) * 400_000_000))
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

    @discardableResult
    func raw(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, contentType: String? = nil, idempotencyKey: String? = nil, authRetry: Bool = true) async throws -> (Data, HTTPURLResponse) {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.httpBody = body
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        req.setValue(UUID().uuidString, forHTTPHeaderField: "X-Request-Id")
        if let tokenProvider {
            do {
                let token = try await tokenProvider(false)
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            } catch {
                throw APIError.unauthenticated
            }
        }
        let started = ProcessInfo.processInfo.systemUptime
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.offline((error as NSError).localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let rtt = ProcessInfo.processInfo.systemUptime - started
        if let st = http.value(forHTTPHeaderField: "x-server-time"), let date = JSONCoding.parseDate(st) {
            clock.observe(serverTime: date, rtt: rtt)
        }
        if http.statusCode == 401, authRetry, let tokenProvider {
            _ = try? await tokenProvider(true)
            return try await raw(method, path, query: query, body: body, contentType: contentType, idempotencyKey: idempotencyKey, authRetry: false)
        }
        guard (200..<300).contains(http.statusCode) else {
            if let env = try? JSONCoding.decoder.decode(ErrorEnvelope.self, from: data) {
                if env.error.code == "UNAUTHENTICATED" { throw APIError.unauthenticated }
                throw APIError.server(status: http.statusCode, code: env.error.code, message: env.error.message, details: env.error.details)
            }
            throw APIError.server(status: http.statusCode, code: "HTTP_\(http.statusCode)", message: "Server error \(http.statusCode)", details: nil)
        }
        return (data, http)
    }

    /// Unauthenticated time sync (`GET /v1/time`).
    func syncTime() async {
        _ = try? await raw("GET", "/v1/time")
    }
}

struct EmptyBody: Codable, Sendable {}
