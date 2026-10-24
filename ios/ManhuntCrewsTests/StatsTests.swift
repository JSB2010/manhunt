import XCTest
import CoreLocation
@testable import ManhuntCrews

/// The game map's own trail belongs to one round and never bridges a gap.
final class OwnTrailTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func c(_ i: Double) -> CLLocationCoordinate2D { .init(latitude: 39.75 + i * 0.0001, longitude: -104.98) }

    func testANewRoundStartsAnEmptyTrail_evenAfterReadySetTheRound() {
        var trail = OwnTrail(roundId: "r1")
        trail.append(c(0), at: t0)
        trail.append(c(1), at: t0.addingTimeInterval(10))
        // Round 1 again (a relaunch mid-round): keep it.
        XCTAssertEqual(trail.continuing("r1").points.count, 2)
        // Round 2: nothing from round 1, so the map never joins where it ended to where round 2 starts.
        let next = trail.continuing("r2")
        XCTAssertEqual(next.roundId, "r2")
        XCTAssertTrue(next.isEmpty)
        XCTAssertNil(next.start)
    }

    func testGapsSplitTheTrail() {
        var trail = OwnTrail(roundId: "r1")
        for i in 0..<3 { trail.append(c(Double(i)), at: t0.addingTimeInterval(Double(i) * 15)) }
        // Tracking paused (app closed) for five minutes, then resumed somewhere else.
        for i in 0..<2 { trail.append(c(Double(10 + i)), at: t0.addingTimeInterval(330 + Double(i) * 15)) }
        XCTAssertEqual(trail.segments.map(\.count), [3, 2])
    }

    func testARestoredTrailMergesInTimeOrder_andKeepsItsStart() {
        var trail = OwnTrail(roundId: "r1")
        trail.append(c(5), at: t0.addingTimeInterval(50)) // a live fix arrives before the restore finishes
        trail.merge((0..<5).map { .init(coordinate: c(Double($0)), at: t0.addingTimeInterval(Double($0) * 10)) }.reversed())
        XCTAssertEqual(trail.points.map(\.at), (0...5).map { t0.addingTimeInterval(Double($0) * 10) })
        XCTAssertEqual(trail.start?.latitude, c(0).latitude)
        // Trimming the oldest fixes keeps the start marker where the round began.
        for i in 0..<OwnTrail.maxPoints { trail.append(c(6), at: t0.addingTimeInterval(60 + Double(i))) }
        XCTAssertEqual(trail.points.count, OwnTrail.maxPoints)
        XCTAssertEqual(trail.start?.latitude, c(0).latitude)
    }
}

/// Highlights, ranks, verdicts and a person's longest/shortest, in words (ADR 0020).
final class StatsTextTests: XCTestCase {
    private func result(_ i: Int, seconds: Int, outcome: String = "CAUGHT", hiding: TeamKey = .A, censored: Bool = false) -> RoundResult {
        let seeking: [TeamKey] = hiding == .A ? [.B] : [.A]
        return RoundResult(roundId: "r\(i)", roundIndex: i, hidingTeam: hiding, seekingTeams: seeking, seekMode: .TOGETHER,
                           teamNames: ["A": "Sasha & Marco", "B": "Theo & Priya"], rosterSnapshot: [:],
                           catchCreditTeams: outcome == "CAUGHT" ? seeking : [], outcome: outcome, headStartSeconds: 600,
                           observedChaseSeconds: seconds, isRightCensored: censored, officialFoundAt: nil, confirmedAt: nil,
                           totalPauseSeconds: 0, roundElapsedSeconds: seconds + 600, pingSlots: 3, pingsReleased: 3, pingsMissing: 0,
                           pingsDelayed: 0, crews: [:], abortedReason: nil, resolvedByDispute: false)
    }

    func testWhereARoundRanksTonight() {
        let night = [result(1, seconds: 900), result(2, seconds: 300, hiding: .B), result(3, seconds: 2700, outcome: "TIMED_OUT", censored: true), result(4, seconds: 4000, outcome: "ABORTED")]
        XCTAssertEqual(StatsText.hideRank(of: 1, in: Array(night.prefix(1)), live: true), "First round of the night")
        XCTAssertEqual(StatsText.hideRank(of: 3, in: night, live: false), "Longest hide of 3 rounds")
        XCTAssertEqual(StatsText.hideRank(of: 1, in: night, live: true), "2nd-longest of 3 rounds so far")
        XCTAssertEqual(StatsText.hideRank(of: 2, in: night, live: false), "Shortest hide of 3 rounds")
        XCTAssertNil(StatsText.hideRank(of: 4, in: night, live: false), "an aborted round has no rank")
    }

    func testNamesAStrongerCrewOnlyWhenTheComparisonIsFair() {
        let name = { (k: TeamKey) in k == .A ? "Sasha & Marco" : "Theo & Priya" }
        let fair = NightComparison(status: "COMPARABLE", strongerHidingTeam: .A, marginSeconds: 192, reasons: [], explanation: "")
        XCTAssertEqual(StatsText.verdict(fair, matchups: 1, name: name).title, "Sasha & Marco lasted longest hiding")
        XCTAssertEqual(StatsText.verdict(fair, matchups: 1, name: name).crew, .A)
        let provisional = NightComparison(status: "PROVISIONAL", strongerHidingTeam: nil, marginSeconds: nil, reasons: ["UNEQUAL_HIDE_ROUNDS", "CENSORED_ROUNDS"], explanation: "")
        let v = StatsText.verdict(provisional, matchups: 1, name: name)
        XCTAssertEqual(v.title, "No overall result")
        XCTAssertNil(v.crew)
        XCTAssertTrue(v.detail.contains("crews hid an unequal number of times and a round ran to the time limit"), v.detail)
        XCTAssertEqual(StatsText.verdict(fair, matchups: 3, name: name).title, "Crews changed during the night")
        XCTAssertNil(StatsText.verdict(fair, matchups: 3, name: name).crew, "with several line-ups the night names no crew")
    }

    func testHighlightWords() {
        let hide = NightHighlight(kind: .LONGEST_HIDE, roundIndex: 3, teams: [.A], names: ["Sasha & Marco"], value: 2700, censored: true, estimated: false)
        XCTAssertEqual(StatsText.value(hide, units: "MILES"), "≥ 45:00")
        XCTAssertEqual(StatsText.sentence(hide, units: "MILES"), "Sasha & Marco were never caught in round 3: at least 45:00")
        XCTAssertEqual(StatsText.badge(.LONGEST_HIDE, live: true), "Longest hide so far")
        XCTAssertEqual(StatsText.badge(.FASTEST_CATCH, live: false), "Fastest catch of the night")
        let foot = NightHighlight(kind: .LEAST_ON_FOOT, roundIndex: 2, teams: [.B], names: ["Theo & Priya"], value: 1609.344, censored: false, estimated: true)
        XCTAssertEqual(StatsText.value(foot, units: "MILES"), "1.00 mi (est.)")
        XCTAssertEqual(StatsText.value(foot, units: "KILOMETERS"), "1.61 km (est.)")
    }

    func testAPersonsLongestAndShortestRounds() {
        let r = { (i: Int, role: Role, s: Int, m: Double?) in
            PersonNightStats.Round(roundIndex: i, team: .A, role: role, outcome: "CAUGHT", seconds: s, censored: false, credited: role == .SEEKING, meters: m, estimated: false)
        }
        let ranges = StatsText.ranges([r(1, .HIDING, 900, 1200), r(2, .SEEKING, 300, 2500), r(3, .HIDING, 1500, 400), r(4, .SEEKING, 600, nil)], units: "KILOMETERS")
        XCTAssertEqual(ranges.map(\.title), ["Hiding time", "On foot while hiding"], "one usable drive is nothing to compare")
        XCTAssertEqual(ranges[0].high.value, "25:00")
        XCTAssertEqual(ranges[0].high.round, 3)
        XCTAssertEqual(ranges[0].low.round, 1)
        XCTAssertEqual(ranges[1].highLabel, "Most")
        XCTAssertEqual(ranges[1].high.value, "1.20 km")
        XCTAssertEqual(ranges[1].low.value, "400 m")
        XCTAssertTrue(StatsText.ranges([r(1, .HIDING, 900, 100), r(2, .HIDING, 900, 100)], units: "MILES").isEmpty, "equal rounds have no longest or shortest")
    }

    func testRecapWords() {
        XCTAssertEqual(RecapText.headline(result(1, seconds: 754)), "Caught after 12:34")
        XCTAssertEqual(RecapText.headline(result(1, seconds: 2700, outcome: "TIMED_OUT", censored: true)), "Never caught")
        XCTAssertEqual(RecapText.subline(result(1, seconds: 2700, outcome: "TIMED_OUT", censored: true)), "Hid for the full 45:00 time limit")
        XCTAssertEqual(RecapText.seekersLine(result(1, seconds: 754)), "Theo & Priya found them")
        var race = result(1, seconds: 754)
        race.seekingTeams = [.B, .C]
        race.seekMode = .RACE
        race.catchCreditTeams = [.C]
        race.teamNames["C"] = "Quinn"
        XCTAssertEqual(RecapText.seekersLine(race), "Quinn made the catch")
        XCTAssertEqual(RecapText.seekersLine(result(1, seconds: 2700, outcome: "TIMED_OUT")), "Theo & Priya sought")
    }

    func testDistanceNeedsUsableGPS() {
        let good = CrewRouteStats(role: .HIDING, distanceTotalMeters: 1200, distanceChaseMeters: 700, gpsCoverageFraction: 0.9, routeQuality: "GOOD", phones: 1)
        XCTAssertEqual(RecapText.distance(good), 1200)
        XCTAssertEqual(RecapText.distance(good, chaseOnly: true), 700)
        var poor = good
        poor.routeQuality = "INSUFFICIENT"
        XCTAssertNil(RecapText.distance(poor))
    }
}

/// Scorecards decode from servers with and without highlights and per-person rounds.
final class ScorecardDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> Scorecard { try JSONCoding.decoder.decode(Scorecard.self, from: Data(json.utf8)) }

    func testDecodesHighlightsAndPersonRounds() throws {
        let sc = try decode("""
        {"teams":{},"comparison":{"status":"PROVISIONAL","strongerHidingTeam":null,"marginSeconds":null,"reasons":["CENSORED_ROUNDS"],"explanation":""},
         "rulesConsistent":true,"rounds":[],"trend":[],"matchups":[],"changes":[],
         "people":[{"personId":"p1","displayName":"Sasha","roundsHid":1,"roundsSought":1,"hideAverageSeconds":900,"hideIncludesCensored":false,"catches":1,
                    "footMeters":1200,"driveMeters":2500,"rounds":[{"roundIndex":1,"team":"A","role":"HIDING","outcome":"CAUGHT","seconds":900,"censored":false,"credited":false,"meters":1200,"estimated":false}]}],
         "highlights":[{"kind":"LONGEST_HIDE","roundIndex":3,"teams":["A"],"names":["Sasha & Marco"],"value":2700,"censored":true,"estimated":false}]}
        """)
        XCTAssertEqual(sc.highlights(in: 3).map(\.kind), [.LONGEST_HIDE])
        XCTAssertEqual(sc.people?.first?.rounds?.first?.meters, 1200)
        XCTAssertEqual(sc.people?.first?.roundsPlayed, 2)
    }

    func testDecodesAScorecardFromBeforeHighlights() throws {
        let sc = try decode("""
        {"teams":{},"comparison":{"status":"INSUFFICIENT","strongerHidingTeam":null,"marginSeconds":null,"reasons":[],"explanation":""},
         "rulesConsistent":true,"rounds":[],"trend":[],
         "people":[{"personId":"p1","displayName":"Sasha","roundsHid":1,"roundsSought":0,"hideAverageSeconds":900,"hideIncludesCensored":false,"catches":0}]}
        """)
        XCTAssertNil(sc.highlights)
        XCTAssertTrue(sc.highlights(in: 1).isEmpty)
        XCTAssertNil(sc.people?.first?.footMeters)
    }
}

/// The replay moves each crew along its simplified route at an even pace, and never across a gap.
final class RouteReplayTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func p(_ lat: Double, _ s: Double) -> RouteRecap.Point { .init(latitude: lat, longitude: -104.98, t: t0.addingTimeInterval(s)) }

    func testInterpolatesAlongALegAndStopsAtAGap() {
        // Simplified to its ends: one straight leg over 100 s, then a gap, then a second segment.
        let team = RouteRecap.Team(team: .A, role: .HIDING, deleted: false, quality: "GOOD", sampleCount: 40,
                                   segments: [.init(points: [p(39.0, 0), p(39.01, 100)]), .init(points: [p(39.05, 400), p(39.06, 500)])])
        XCTAssertNil(team.position(at: t0.addingTimeInterval(-1)), "nothing before the route begins")
        XCTAssertEqual(team.position(at: t0.addingTimeInterval(50))!.latitude, 39.005, accuracy: 1e-9)
        XCTAssertEqual(team.travelled(by: t0.addingTimeInterval(50)).map(\.count), [2])
        // In the gap: where it was last recorded, not somewhere along an invented line.
        XCTAssertEqual(team.position(at: t0.addingTimeInterval(250))!.latitude, 39.01, accuracy: 1e-9)
        XCTAssertEqual(team.travelled(by: t0.addingTimeInterval(450)).map(\.count), [2, 2])
        XCTAssertEqual(team.position(at: t0.addingTimeInterval(450))!.latitude, 39.055, accuracy: 1e-9)
        XCTAssertEqual(team.position(at: t0.addingTimeInterval(900))!.latitude, 39.06, accuracy: 1e-9)
    }
}
