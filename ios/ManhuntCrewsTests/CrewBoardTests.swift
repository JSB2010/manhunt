import XCTest
@testable import ManhuntCrews

/// People make the crew (ADR 0019): the editor's board, crew names, and what the summary says changed.
final class CrewBoardTests: XCTestCase {
    private func p(_ id: String, _ name: String) -> RosterEntryBody { RosterEntryBody(personId: id, displayName: name) }

    private var board: CrewBoard {
        CrewBoard(crews: [
            .init(key: .A, roster: [p("sasha", "Sasha Okafor"), p("theo", "Theo Marsh")]),
            .init(key: .B, roster: [p("marco", "Marco Bellini"), p("priya", "Priya Nandan")]),
        ], bench: [p("ezra", "Ezra Holt")])
    }

    func testNamesCrewsLikeTheServer() {
        let five = [p("a", "Sasha Okafor"), p("b", "Marco Bellini"), p("c", "Theo Marsh"), p("d", "Dana Whitfield"), p("e", "Priya Nandan")]
        XCTAssertEqual(CrewNames.label(Array(five.prefix(1)), .A), "Sasha")
        XCTAssertEqual(CrewNames.label(Array(five.prefix(2)), .A), "Sasha & Marco")
        XCTAssertEqual(CrewNames.label(Array(five.prefix(3)), .A), "Sasha, Marco & Theo")
        XCTAssertEqual(CrewNames.label(Array(five.prefix(4)), .A), "Sasha, Marco & 2 more")
        XCTAssertEqual(CrewNames.label(five, .B), "Sasha, Marco & 3 more")
        XCTAssertEqual(CrewNames.label([], .A), "Blue crew")
        XCTAssertEqual(CrewNames.label([], .C), "Green crew")
        let short = CrewNames.short([p("a", "Marco Bellini"), p("b", "Marco Ruiz"), p("c", "Sam"), p("d", "Sam"), p("e", "Ezra Holt"), p("f", "Ezra Hart")])
        XCTAssertEqual(short["a"], "Marco B.")
        XCTAssertEqual(short["b"], "Marco R.")
        XCTAssertEqual(short["c"], "Sam")
        XCTAssertEqual(short["e"], "Ezra Holt")
    }

    func testMovesPeopleBetweenCrewsAndSittingOut() {
        var b = board
        b.move("theo", to: .crew(.B), before: "priya")
        XCTAssertEqual(b.people(in: .crew(.B)).map(\.displayName), ["Marco Bellini", "Theo Marsh", "Priya Nandan"])
        XCTAssertEqual(b.label(.A), "Sasha")
        b.move("ezra", to: .crew(.A))
        XCTAssertEqual(b.place(of: "ezra"), .crew(.A))
        XCTAssertTrue(b.bench.isEmpty)
        b.move("marco", to: .bench)
        XCTAssertEqual(b.place(of: "marco"), .bench)
        b.remove("priya")
        XCTAssertNil(b.place(of: "priya"))
        // Adding someone already in the night moves them rather than listing them twice.
        b.add(p("marco", "Marco Bellini"), to: .crew(.B))
        XCTAssertEqual(b.everyone.filter { $0.personId == "marco" }.count, 1)
        XCTAssertEqual(b.place(of: "marco"), .crew(.B))
    }

    func testDroppingACrewSpreadsItsPeople_andShuffleLeavesSittingOutAlone() {
        var b = board
        b.setCrewCount(3)
        XCTAssertEqual(b.keys, [.A, .B, .C])
        b.move("sasha", to: .crew(.C))
        b.setCrewCount(2)
        XCTAssertEqual(b.keys, [.A, .B])
        XCTAssertEqual(b.place(of: "sasha"), .crew(.A)) // the smaller crew
        for _ in 0..<20 {
            var s = b
            s.shuffle { $0.personId == "sasha" || $0.personId == "marco" }
            XCTAssertEqual(s.bench.map(\.personId), ["ezra"])
            XCTAssertEqual(Set(s.crews.map { $0.roster.count }), [2])
            // The two phone owners land on different crews.
            XCTAssertNotEqual(s.place(of: "sasha"), s.place(of: "marco"))
        }
    }

    func testReadsSittingOutFromTheView_andAgreesVerbsWithCrewSize() throws {
        let json = ##"{"title":"t","scheduledDate":"2026-10-24","status":"LOBBY","isHost":false,"myTeam":null,"completedRoundCount":0,"rules":{"headStartSeconds":600,"pingIntervalSeconds":600,"visiblePingHistoryCount":1,"maxChaseSeconds":null,"confirmationTimeoutSeconds":120,"manualPausesEnabled":true,"maxPingGpsAgeSeconds":60,"maxPingAccuracyMeters":50},"teams":{"A":{"teamId":"a","key":"A","name":"Sasha","color":"#1E88E5","roster":[{"personId":"sasha","displayName":"Sasha Okafor"}],"operators":[],"isMine":false},"B":{"teamId":"b","key":"B","name":"Marco & Priya","color":"#F4511E","roster":[{"personId":"marco","displayName":"Marco Bellini"},{"personId":"priya","displayName":"Priya Nandan"}],"operators":[],"isMine":false}},"sittingOut":{"roster":[{"personId":"ezra","displayName":"Ezra Holt"}],"operators":[{"uid":"u-ezra","personId":"ezra","displayName":"Ezra","isMe":true,"consentGiven":false}]},"joinCode":null,"revoked":false}"##
        let s = try JSONCoding.decoder.decode(SessionHeader.self, from: Data(json.utf8))
        XCTAssertTrue(s.amSittingOut)
        XCTAssertEqual(CrewBoard(s).bench.map(\.personId), ["ezra"])
        XCTAssertEqual(s.verb([.A], "hides", "hide"), "hides")
        XCTAssertEqual(s.verb([.B], "hides", "hide"), "hide")
        XCTAssertEqual(s.verb([.A, .B], "seeks", "seek"), "seek")
        // Older servers send no sittingOut.
        let old = try JSONCoding.decoder.decode(SessionHeader.self, from: Data(json.replacingOccurrences(of: #","sittingOut":{"roster":[{"personId":"ezra","displayName":"Ezra Holt"}],"operators":[{"uid":"u-ezra","personId":"ezra","displayName":"Ezra","isMe":true,"consentGiven":false}]}"#, with: "").utf8))
        XCTAssertTrue(old.bench.roster.isEmpty)
        XCTAssertFalse(old.amSittingOut)
    }

    func testSaysWhatChangedBeforeARound() throws {
        let json = #"{"roundIndex":3,"joined":["Ezra Holt"],"left":["Theo Marsh"],"moved":[{"name":"Sam","from":"B","to":"A"}],"rules":[{"field":"headStartSeconds","from":600,"to":300},{"field":"maxChaseSeconds","from":null,"to":1800},{"field":"seekMode","from":"TOGETHER","to":"RACE"}]}"#
        let c = try JSONCoding.decoder.decode(RoundChanges.self, from: Data(json.utf8))
        XCTAssertEqual(ChangeText.describe(c), "Sam → Blue crew · Ezra Holt joined · Theo Marsh out · Head start 10 min → 5 min · Chase cap none → 30 min · Seekers race")
        XCTAssertEqual(Matchup(rounds: [1, 2], rulesFingerprint: "x", crews: [], comparison: .init(status: "INSUFFICIENT", reasons: [], explanation: "")).title, "Rounds 1–2")
        XCTAssertEqual(Matchup(rounds: [1, 2, 5], rulesFingerprint: "x", crews: [], comparison: .init(status: "INSUFFICIENT", reasons: [], explanation: "")).title, "Rounds 1, 2, and 5")
    }
}

final class CrewNameDisplayTests: XCTestCase {
    func testListsPeopleOnlyWhenTheNameDoesNot() {
        let two = [PersonRef(personId: "m", displayName: "Morgan"), PersonRef(personId: "t", displayName: "Taylor")]
        XCTAssertTrue(CrewNames.nameListsEveryone("Morgan & Taylor", people: two, key: .A))
        // A typed name from an older night, full names, or "& N more" still get the list.
        XCTAssertFalse(CrewNames.nameListsEveryone("Owls", people: two, key: .A))
        XCTAssertFalse(CrewNames.nameListsEveryone("Jules & Taylor", people: [PersonRef(personId: "j", displayName: "Jules Park"), two[1]], key: .B))
        XCTAssertFalse(CrewNames.nameListsEveryone("Blue crew", people: [], key: .A))
    }
}
