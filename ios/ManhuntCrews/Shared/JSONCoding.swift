import Foundation

enum JSONCoding {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let lock = NSLock()

    static func parseDate(_ s: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return fractional.date(from: s) ?? plain.date(from: s)
    }

    static func format(_ d: Date) -> String {
        lock.lock(); defer { lock.unlock() }
        return fractional.string(from: d)
    }

    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self), let date = parseDate(s) { return date }
            if let ms = try? c.decode(Double.self) { return Date(timeIntervalSince1970: ms / 1000) }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Invalid date")
        }
        return d
    }

    static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(format(date))
        }
        return e
    }
}
