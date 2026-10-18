import XCTest
import CoreLocation
@testable import ManhuntCrews

final class ClockTests: XCTestCase {
    func testRunningClockUsesServerTimestamps() {
        let since = Date(timeIntervalSince1970: 1_000)
        let c = ClockView(accumulatedMs: 60_000, runningSince: since)
        XCTAssertEqual(c.elapsedMs(at: since.addingTimeInterval(30)), 90_000, accuracy: 0.5)
        // Device clock changes don't matter: only the server "now" passed in counts.
        XCTAssertEqual(c.elapsedMs(at: since), 60_000, accuracy: 0.5)
    }

    func testFrozenClockDoesNotAdvance() {
        let c = ClockView(accumulatedMs: 26 * 60_000, runningSince: nil)
        XCTAssertEqual(c.elapsedMs(at: Date().addingTimeInterval(9999)), 26 * 60_000)
    }

    func testServerClockAnchorsToUptime() {
        let clock = ServerClock()
        let server = Date(timeIntervalSince1970: 2_000_000_000)
        clock.observe(serverTime: server, rtt: 0.2)
        let now = clock.now()
        XCTAssertEqual(now.timeIntervalSince(server), 0.1, accuracy: 0.5)
    }

    func testFormatting() {
        XCTAssertEqual(Fmt.clock(26 * 60), "26:00")
        XCTAssertEqual(Fmt.clock(3725), "1:02:05")
        XCTAssertEqual(Fmt.clock(-5), "0:00")
        XCTAssertEqual(Fmt.distance(1609.344, units: "MILES"), "1.00 mi")
        XCTAssertEqual(Fmt.distance(2500, units: "KILOMETERS"), "2.50 km")
    }
}

final class SampleFilterTests: XCTestCase {
    private let base = CLLocationCoordinate2D(latitude: 39.7392, longitude: -104.9903)
    private func offset(_ meters: Double) -> CLLocationCoordinate2D {
        .init(latitude: base.latitude + meters / 111_195, longitude: base.longitude)
    }

    func testKeepsFirstAndThrottles() {
        var f = SampleFilter()
        let t0 = Date()
        XCTAssertTrue(f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: 5, stationary: false))
        XCTAssertFalse(f.shouldKeep(timestamp: t0.addingTimeInterval(2), coordinate: offset(20), horizontalAccuracy: 5, stationary: false), "under min interval")
        XCTAssertTrue(f.shouldKeep(timestamp: t0.addingTimeInterval(6), coordinate: offset(20), horizontalAccuracy: 5, stationary: false), "moved 20 m after 6 s")
    }

    func testStationaryCadence() {
        var f = SampleFilter()
        let t0 = Date()
        _ = f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: 5, stationary: true)
        XCTAssertFalse(f.shouldKeep(timestamp: t0.addingTimeInterval(20), coordinate: base, horizontalAccuracy: 5, stationary: true))
        XCTAssertTrue(f.shouldKeep(timestamp: t0.addingTimeInterval(31), coordinate: base, horizontalAccuracy: 5, stationary: true))
    }

    func testRejectsInvalidAndOutOfOrder() {
        var f = SampleFilter()
        let t0 = Date()
        XCTAssertFalse(f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: -1, stationary: false))
        XCTAssertFalse(f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: 500, stationary: false))
        XCTAssertTrue(f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: 5, stationary: false))
        XCTAssertFalse(f.shouldKeep(timestamp: t0.addingTimeInterval(-10), coordinate: offset(50), horizontalAccuracy: 5, stationary: false))
    }

    func testMovingMaxIntervalKeepsSlowMovement() {
        var f = SampleFilter()
        let t0 = Date()
        _ = f.shouldKeep(timestamp: t0, coordinate: base, horizontalAccuracy: 5, stationary: false)
        XCTAssertFalse(f.shouldKeep(timestamp: t0.addingTimeInterval(8), coordinate: offset(3), horizontalAccuracy: 5, stationary: false))
        XCTAssertTrue(f.shouldKeep(timestamp: t0.addingTimeInterval(16), coordinate: offset(6), horizontalAccuracy: 5, stationary: false))
    }
}

final class DecodingTests: XCTestCase {
    /// A seeker view exactly as the backend renders it (see backend views.ts).
    let seekerView = """
    {"schemaVersion":1,"uid":"u2","sessionId":"s1","renderedAt":"2026-10-17T20:15:00.000Z","stateVersion":1792267500000001,
     "session":{"title":"Friday","scheduledDate":"2026-10-17","status":"IN_ROUND","isHost":false,"myTeam":"B","totalRounds":4,"completedRoundCount":0,
       "rules":{"headStartSeconds":600,"pingIntervalSeconds":600,"visiblePingHistoryCount":1,"totalRounds":4,"initialHidingTeam":"A","alternateRoles":true,"maxChaseSeconds":null,"confirmationTimeoutSeconds":120,"manualPausesEnabled":true,"maxPingGpsAgeSeconds":60,"maxPingAccuracyMeters":50},
       "teams":{"A":{"teamId":"t1","key":"A","name":"Crew A","color":"#1E88E5","roster":[{"personId":"p1","displayName":"Morgan"}],"operatorDisplayName":"Morgan","hasOperator":true,"isMine":false,"consentGiven":true},
                "B":{"teamId":"t2","key":"B","name":"Crew B","color":"#F4511E","roster":[],"operatorDisplayName":"Taylor","hasOperator":true,"isMine":true,"consentGiven":true}},"revoked":false},
     "round":{"id":"r1","index":1,"state":"CHASE","pausedFromState":null,"myRole":"SEEKING","hidingTeam":"A","seekingTeam":"B",
       "rules":{"headStartSeconds":600,"pingIntervalSeconds":600,"visiblePingHistoryCount":1,"totalRounds":4,"initialHidingTeam":"A","alternateRoles":true,"maxChaseSeconds":null,"confirmationTimeoutSeconds":120,"manualPausesEnabled":true,"maxPingGpsAgeSeconds":60,"maxPingAccuracyMeters":50},
       "ready":{"A":true,"B":true},"roleOverride":null,"roundStartAt":"2026-10-17T20:00:00.000Z","headStartEndsAt":null,"chaseStartAt":"2026-10-17T20:10:00.000Z",
       "headStartClock":{"accumulatedMs":600000,"runningSince":null},"chaseClock":{"accumulatedMs":0,"runningSince":"2026-10-17T20:10:00.000Z"},
       "nextPingAt":"2026-10-17T20:20:00.000Z","nextPingIndex":1,"timeCapAt":null,
       "pins":[{"index":0,"scheduledAt":"2026-10-17T20:10:00.000Z","releasedAt":"2026-10-17T20:10:00.120Z","observedAt":"2026-10-17T20:09:47.000Z","latitude":39.74,"longitude":-104.99,"accuracyMeters":6,"ageSeconds":13,"delayed":false}],
       "pingLog":[{"index":0,"scheduledAt":"2026-10-17T20:10:00.000Z","releasedAt":"2026-10-17T20:10:00.120Z","status":"RELEASED","ageSeconds":13,"accuracyMeters":6,"delayed":false}],
       "pause":null,"pendingPauseRequest":null,"myClaim":null,"captureRequest":null,"lastClaimOutcome":null,
       "myHealth":{"lastHeartbeatAt":"2026-10-17T20:14:50.000Z","lastSampleRecordedAt":"2026-10-17T20:14:48.000Z","lastSampleAccuracyMeters":5,"permission":"WHEN_IN_USE","preciseLocation":true,"trackingActive":true,"backgroundSessionActive":true,"lowPowerMode":false,"batteryLevel":0.8,"networkReachable":true,"queuedSamples":0},
       "opponentHealth":{"state":"ACTIVE","lastHeartbeatAt":"2026-10-17T20:14:30.000Z","issues":[]},"result":null,"endedAt":null,"phaseGeneration":2},
     "previousRounds":[],"nextRound":null}
    """

    func testDecodesSeekerView() throws {
        let v = try JSONCoding.decoder.decode(SessionViewDoc.self, from: Data(seekerView.utf8))
        XCTAssertEqual(v.round?.state, .CHASE)
        XCTAssertEqual(v.round?.myRole, .SEEKING)
        XCTAssertEqual(v.round?.pins.count, 1)
        XCTAssertEqual(v.round?.pins.first?.ageSeconds, 13)
        XCTAssertTrue(v.round?.isReady(.A) ?? false)
        let chase = try XCTUnwrap(v.round?.chaseClock)
        let fiveMinIn = try XCTUnwrap(JSONCoding.parseDate("2026-10-17T20:15:00.000Z"))
        XCTAssertEqual(chase.elapsedMs(at: fiveMinIn), 300_000, accuracy: 1)
    }

    func testRulesPatchEncodesExplicitNulls() throws {
        var r = Rules.defaults
        r.visiblePingHistoryCount = nil
        r.maxChaseSeconds = nil
        let json = String(data: try JSONCoding.encoder.encode(RulesPatch(r)), encoding: .utf8)!
        XCTAssertTrue(json.contains("\"visiblePingHistoryCount\":null"))
        XCTAssertTrue(json.contains("\"maxChaseSeconds\":null"))
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "manhuntcrews://join?code=ABCD2345")!), .join(code: "ABCD2345"))
        XCTAssertEqual(DeepLink(url: URL(string: "manhuntcrews://friend?token=xyz")!), .friend(token: "xyz"))
        XCTAssertNil(DeepLink(url: URL(string: "https://evil.example/join?code=1")!))
        XCTAssertNil(DeepLink(url: URL(string: "manhuntcrews://join")!))
    }
}

final class EncryptedStoreTests: XCTestCase {
    func testRoundTripAndCiphertextOnDisk() throws {
        let secret = Data("lat=39.7392,lon=-104.9903".utf8)
        try EncryptedStore.write(secret, name: "test-roundtrip.bin")
        defer { EncryptedStore.remove(name: "test-roundtrip.bin") }
        XCTAssertEqual(EncryptedStore.read(name: "test-roundtrip.bin"), secret)
        let raw = try Data(contentsOf: EncryptedStore.directory.appendingPathComponent("test-roundtrip.bin"))
        XCTAssertNil(raw.range(of: Data("39.7392".utf8)), "plaintext must not be on disk")
    }

    func testTelemetryQueueBatchesAndAcks() async throws {
        let q = TelemetryQueue()
        await q.clear()
        let start = Date()
        await q.setContext(.init(sessionId: "s", roundId: "r-test", role: .HIDING, roundStartAt: start))
        for i in 0..<3 {
            await q.enqueue(SamplePayload(pointId: UUID().uuidString, recordedAt: start.addingTimeInterval(Double(i) * 10), latitude: 1, longitude: 2, horizontalAccuracyMeters: 5))
        }
        // Pre-round samples are dropped.
        await q.enqueue(SamplePayload(pointId: UUID().uuidString, recordedAt: start.addingTimeInterval(-60), latitude: 1, longitude: 2, horizontalAccuracyMeters: 5))
        let count = await q.count
        XCTAssertEqual(count, 3)
        let first = await q.nextBatch()
        let again = await q.nextBatch()
        XCTAssertEqual(first?.1, again?.1, "unacknowledged batch keeps its id for idempotent retry")
        await q.ack(batchId: first!.1)
        let remaining = await q.count
        XCTAssertEqual(remaining, 0)
        await q.clear()
    }
}
