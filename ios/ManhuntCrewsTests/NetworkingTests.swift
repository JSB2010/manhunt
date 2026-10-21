import XCTest
@testable import ManhuntCrews

/// Cellular efficiency and recovery (ADR 0016): compressed backlogs, conditional
/// reloads, newest-first flushes, and a bad batch never blocking the queue.
private func stubbedClient(_ handler: @escaping (URLRequest, Int) -> StubProtocol.Reply) -> (APIClient, String) {
    let host = "net-\(UUID().uuidString.prefix(8).lowercased()).test"
    StubProtocol.register(host, handler)
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubProtocol.self]
    return (APIClient(baseURL: URL(string: "https://\(host)")!, clock: ServerClock(), configuration: cfg), host)
}

private let health = HealthPayload(permission: "WHEN_IN_USE", preciseLocation: true, trackingActive: true, backgroundSessionActive: true, lowPowerMode: false, batteryLevel: 0.8, networkReachable: true, appVersion: "t", queuedSamples: 0, lastFixAgeSeconds: 2, lastFixAccuracyMeters: 5)

private func samples(_ n: Int, from start: Date = Date()) -> [SamplePayload] {
    (0..<n).map { i in
        SamplePayload(pointId: UUID().uuidString.lowercased(), recordedAt: start.addingTimeInterval(Double(i)), latitude: 39.7 + Double(i) * 1e-5, longitude: -104.9, horizontalAccuracyMeters: 5, speedMetersPerSecond: nil, courseDegrees: nil, altitudeMeters: nil)
    }
}

final class GzipTests: XCTestCase {
    func testCRC32MatchesTheStandardCheckValue() {
        XCTAssertEqual(Gzip.crc32(Data("123456789".utf8)), 0xCBF4_3926)
    }

    func testProducesAValidGzipMember() throws {
        let original = Data(String(repeating: "{\"latitude\":39.7392,\"longitude\":-104.9903},", count: 200).utf8)
        let gz = try XCTUnwrap(Gzip.compress(original))
        XCTAssertEqual(Array(gz.prefix(3)), [0x1f, 0x8b, 0x08])
        XCTAssertLessThan(gz.count, original.count / 4)
        let trailer = gz.suffix(8)
        let crc = trailer.prefix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
        let size = trailer.suffix(4).enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
        XCTAssertEqual(crc, Gzip.crc32(original))
        XCTAssertEqual(Int(size), original.count)
        let inflated = try (gz.dropFirst(10).dropLast(8) as NSData).decompressed(using: .zlib) as Data
        XCTAssertEqual(inflated, original)
    }
}

final class ConditionalReloadTests: XCTestCase {
    func testSends304AwareConditionalGet() async throws {
        let (api, host) = stubbedClient { req, _ in
            req.value(forHTTPHeaderField: "If-None-Match") == "\"h1\"" ? StubProtocol.Reply(status: 304) : .json(500, [:])
        }
        let v = try await api.session("s1", ifNoneMatch: "h1")
        XCTAssertNil(v, "304 means nothing changed")
        XCTAssertEqual(StubProtocol.requests(host).count, 1)
    }
}

final class UploadEncodingTests: XCTestCase {
    private let ok: StubProtocol.Reply = .json(200, ["accepted": 0, "duplicates": 0, "rejected": [], "clockSkewMs": 0])

    func testLargeBacklogsAreGzippedAndSmallBatchesAreNot() async throws {
        let (api, host) = stubbedClient { [ok] _, _ in ok }
        _ = try await api.uploadLocations("s", "r", LocationBatchBody(batchId: UUID().uuidString, sentAt: Date(), samples: samples(3), health: health))
        _ = try await api.uploadLocations("s", "r", LocationBatchBody(batchId: UUID().uuidString, sentAt: Date(), samples: samples(150), health: health))
        let reqs = StubProtocol.requests(host)
        XCTAssertNil(reqs[0].value(forHTTPHeaderField: "Content-Encoding"))
        XCTAssertEqual(reqs[1].value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        XCTAssertEqual(reqs[1].value(forHTTPHeaderField: "Content-Type"), "application/json")
    }
}

final class QueueRecoveryTests: XCTestCase {
    func testNewestFixesGoFirstAfterAnOutage() async throws {
        let q = TelemetryQueue()
        await q.clear()
        let start = Date()
        await q.setContext(.init(sessionId: "s", roundId: "r-newest", role: .HIDING, roundStartAt: start))
        let all = samples(60, from: start)
        for s in all { await q.enqueue(s) }
        let urgentBatch = await q.nextBatch(newestFirst: true)
        let urgent = try XCTUnwrap(urgentBatch)
        XCTAssertEqual(urgent.2.map(\.pointId), all.suffix(20).map(\.pointId))
        await q.ack(batchId: urgent.1)
        let restBatch = await q.nextBatch()
        let rest = try XCTUnwrap(restBatch)
        XCTAssertEqual(rest.2.map(\.pointId), all.prefix(40).map(\.pointId))
        await q.clear()
    }

    func testARejectedBatchIsDroppedInsteadOfBlockingTheQueue() async throws {
        let q = TelemetryQueue()
        await q.clear()
        let start = Date()
        await q.setContext(.init(sessionId: "s", roundId: "r-drop", role: .SEEKING, roundStartAt: start))
        for s in samples(5, from: start) { await q.enqueue(s) }
        let firstBatch = await q.nextBatch()
        let first = try XCTUnwrap(firstBatch)
        await q.dropInFlight()
        for s in samples(2, from: start.addingTimeInterval(10)) { await q.enqueue(s) }
        let nextBatch = await q.nextBatch()
        let next = try XCTUnwrap(nextBatch)
        XCTAssertNotEqual(next.1, first.1)
        XCTAssertEqual(next.2.count, 2)
        await q.clear()
    }

    func testHealthOnlyChangesOthersNoticeCount() {
        var h = health
        h.lastFixAgeSeconds = 40
        h.batteryLevel = 0.5
        XCTAssertFalse(h.differsMeaningfully(from: health))
        h.lowPowerMode = true
        XCTAssertTrue(h.differsMeaningfully(from: health))
    }
}
