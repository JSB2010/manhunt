import XCTest

/// Two-simulator end-to-end round with the real app on both phones, the real
/// local backend (Firebase emulators + API + worker) and simulated GPS routes.
/// Run by `scripts/e2e-two-simulators.sh`, which launches `testHost` on one
/// simulator and `testSeeker` on another *at the same time*. The two tests only
/// coordinate through the backend plus a shared directory used to pass the
/// invite code (as people would read it aloud) and a "claim submitted" marker.
///
/// Without MH_E2E_ROLE these tests skip, so normal `xcodebuild test` runs stay fast.
struct E2ETimeout: Error, CustomStringConvertible {
    let file: String
    var description: String { "Timed out waiting for the other phone (\(file))" }
}

final class TwoPhoneE2ETests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var dir: URL { URL(fileURLWithPath: env["MH_E2E_DIR"] ?? NSTemporaryDirectory()) }

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: Host = Crew A operator, hides in round 1

    func testHost() throws {
        try require(role: "host")
        let app = launch()
        signIn(app)

        tap(app.buttons["home.create"])
        let ack = app.switches["create.ack"]
        scrollTo(ack, in: app)
        ack.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        tap(app.buttons["create.submit"])

        tap(app.buttons["lobby.invite"], timeout: 30)
        let code = app.staticTexts["invite.code"]
        XCTAssertTrue(code.waitForExistence(timeout: 30))
        snapshot("host-invite-code")
        try write("invite.txt", code.label)
        tap(app.buttons["invite.done"])

        acceptConsent(app)
        let ready = app.buttons["lobby.ready"]
        waitUntil(ready, enabled: true, timeout: 300) // seeker operator must have joined
        ready.tap()
        allowSystemAlerts()
        let start = app.buttons["lobby.start"]
        scrollTo(start, in: app)
        waitUntil(start, enabled: true, timeout: 300) // both ready
        snapshot("host-lobby-both-ready")
        start.tap()
        if app.buttons["warnings.startAnyway"].waitForExistence(timeout: 6) {
            snapshot("host-start-warnings")
            app.buttons["warnings.startAnyway"].tap()
        }

        let phase = app.staticTexts["game.phase"]
        XCTAssertTrue(phase.waitForExistence(timeout: 30))
        XCTAssertTrue(phase.label.contains("HEAD START"), phase.label)
        snapshot("host-head-start")

        // Lock-screen proxy: background the hider app for the whole chase. Background
        // location + uploads must keep feeding fresh pings to the seeker.
        XCUIDevice.shared.press(.home)
        _ = try waitForFile("claim-submitted.txt", timeout: 900)
        app.activate()

        let confirm = app.buttons["confirm.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 60), "hider should be asked to confirm the catch")
        snapshot("host-confirm-catch")
        confirm.tap()

        let outcome = app.staticTexts["recap.outcome"]
        XCTAssertTrue(outcome.waitForExistence(timeout: 90))
        XCTAssertTrue(outcome.label.contains("Caught after"), outcome.label)
        snapshot("host-recap")
        try write("host-done.txt", outcome.label)
    }

    // MARK: Seeker = Crew B operator, seeks in round 1

    func testSeeker() throws {
        try require(role: "seeker")
        let app = launch()
        signIn(app)

        let code = try waitForFile("invite.txt", timeout: 900)
        tap(app.buttons["home.join"])
        let field = app.textFields["join.code"]
        tap(field)
        field.typeText(code)
        tap(app.buttons["join.lookup"])
        tap(app.buttons["join.submit"], timeout: 20)

        acceptConsent(app)
        let ready = app.buttons["lobby.ready"]
        waitUntil(ready, enabled: true, timeout: 60)
        ready.tap()
        allowSystemAlerts()
        snapshot("seeker-lobby-ready")

        let phase = app.staticTexts["game.phase"]
        XCTAssertTrue(phase.waitForExistence(timeout: 300), "round should start")
        snapshot("seeker-head-start")
        // No ping may exist during the head start.
        XCTAssertFalse(app.staticTexts["game.lastPing"].exists, "no hider location before the first scheduled ping")

        let lastPing = app.staticTexts["game.lastPing"]
        XCTAssertTrue(lastPing.waitForExistence(timeout: 150), "first ping should release when the head start ends")
        XCTAssertTrue(phase.label.contains("CHASE"), phase.label)
        snapshot("seeker-first-ping")
        try write("first-ping.txt", lastPing.label)

        // Wait for the second scheduled ping (60 s interval in UI-test rules).
        let firstLabel = lastPing.label
        waitUntil(timeout: 120) { lastPing.label != firstLabel && lastPing.label.contains("sample age") }
        snapshot("seeker-second-ping")
        try write("second-ping.txt", lastPing.label)

        tap(app.buttons["game.photoCatch"])
        tap(app.buttons["capture.simPhoto"], timeout: 20)
        tap(app.buttons["capture.submit"], timeout: 20)
        let back = app.buttons["capture.backToMap"]
        XCTAssertTrue(back.waitForExistence(timeout: 60), "server should accept the catch claim")
        snapshot("seeker-claim-submitted")
        try write("claim-submitted.txt", "ok")
        back.tap()

        let outcome = app.staticTexts["recap.outcome"]
        XCTAssertTrue(outcome.waitForExistence(timeout: 900), "hider confirmation should complete the round")
        XCTAssertTrue(outcome.label.contains("Caught after"), outcome.label)
        snapshot("seeker-recap")
        try write("seeker-done.txt", outcome.label)
    }

    // MARK: Helpers

    private func require(role: String) throws {
        guard env["MH_E2E_ROLE"] == role else { throw XCTSkip("Two-phone E2E (\(role)) runs only via scripts/e2e-two-simulators.sh") }
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestShortRules"]
        app.launch()
        return app
    }

    private func signIn(_ app: XCUIApplication) {
        let email = app.textFields["signin.email"]
        if email.waitForExistence(timeout: 20) {
            email.tap()
            email.typeText(env["MH_E2E_EMAIL"] ?? "")
            let pw = app.secureTextFields["signin.password"]
            pw.tap()
            pw.typeText(env["MH_E2E_PASSWORD"] ?? "")
            tap(app.buttons["signin.submit"])
        }
        XCTAssertTrue(app.buttons["home.create"].waitForExistence(timeout: 30), "should reach Home after sign-in")
        dismissSavePasswordPrompt(app)
    }

    private func acceptConsent(_ app: XCUIApplication) {
        tap(app.buttons["lobby.consent"], timeout: 30)
        for id in ["consent.t1", "consent.t2", "consent.t3"] {
            let t = app.switches[id]
            XCTAssertTrue(t.waitForExistence(timeout: 10))
            scrollTo(t, in: app)
            t.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        }
        let accept = app.buttons["consent.accept"]
        scrollTo(accept, in: app)
        waitUntil(accept, enabled: true, timeout: 10)
        accept.tap()
    }

    /// iOS offers to save the typed password (system AutoFill sheet); decline it.
    private func dismissSavePasswordPrompt(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<3 {
            for candidate in [app.buttons["Not Now"], springboard.buttons["Not Now"]] where candidate.waitForExistence(timeout: 2) {
                candidate.tap()
            }
        }
    }

    private func allowSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "Allow While Using App", "OK"] {
            let b = springboard.buttons[label]
            if b.waitForExistence(timeout: 3) { b.tap() }
        }
    }

    private func tap(_ e: XCUIElement, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing \(e)", file: file, line: line)
        waitUntil(e, enabled: true, timeout: timeout)
        e.tap()
    }

    private func scrollTo(_ e: XCUIElement, in app: XCUIApplication) {
        var tries = 0
        while (!e.exists || !e.isHittable) && tries < 12 {
            app.swipeUp()
            tries += 1
        }
    }

    private func waitUntil(_ e: XCUIElement, enabled: Bool, timeout: TimeInterval) {
        let exp = expectation(for: NSPredicate(format: "isEnabled == %@", NSNumber(value: enabled)), evaluatedWith: e)
        wait(for: [exp], timeout: timeout)
    }

    private func waitUntil(timeout: TimeInterval, _ condition: @escaping () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        XCTFail("condition not met within \(timeout)s")
    }

    private func write(_ name: String, _ text: String) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try text.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    private func waitForFile(_ name: String, timeout: TimeInterval) throws -> String {
        let url = dir.appendingPathComponent(name)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let s = try? String(contentsOf: url, encoding: .utf8), !s.isEmpty { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        throw E2ETimeout(file: name)
    }

    private func snapshot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
