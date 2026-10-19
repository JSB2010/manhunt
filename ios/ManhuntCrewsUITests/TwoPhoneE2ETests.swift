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
        let ack = app.buttons["create.ack"]
        scrollTo(ack, in: app)
        XCTAssertTrue(ack.waitForExistence(timeout: 5))
        check(ack)
        let submit = app.buttons["create.submit"]
        tap(submit)
        // Under heavy load a tap on the sheet's toolbar can be dropped. Retry only while the
        // form is still up and idle (a busy Create shows a spinner, not this button).
        for _ in 0..<2 where !app.buttons["lobby.invite"].waitForExistence(timeout: 10) && submit.exists && submit.isEnabled {
            submit.tap()
        }

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
        allowSystemAlerts(app)
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
        XCTAssertTrue(phase.label.localizedCaseInsensitiveContains("head start"), phase.label)
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

        // ---- Round 2: roles swap. Host's crew now SEEKS; nothing starts automatically.
        let next = app.buttons["recap.nextRound"]
        scrollTo(next, in: app)
        tap(next, timeout: 30)
        let ready2 = app.buttons["lobby.ready"]
        XCTAssertTrue(ready2.waitForExistence(timeout: 30), "round 2 lobby")
        snapshot("host-round2-lobby")
        waitUntil(ready2, enabled: true, timeout: 60)
        ready2.tap()
        let start2 = app.buttons["lobby.start"]
        scrollTo(start2, in: app)
        waitUntil(start2, enabled: true, timeout: 300)
        start2.tap()
        if app.buttons["warnings.startAnyway"].waitForExistence(timeout: 6) { app.buttons["warnings.startAnyway"].tap() }
        let phase2 = app.staticTexts["game.phase"]
        XCTAssertTrue(phase2.waitForExistence(timeout: 30))
        XCTAssertTrue(phase2.label.localizedCaseInsensitiveContains("seeking"), "host seeks in round 2: \(phase2.label)")
        let ping2 = app.staticTexts["game.lastPing"]
        XCTAssertTrue(ping2.waitForExistence(timeout: 150), "round 2 first ping")
        XCTAssertTrue(ping2.label.contains("#0"), ping2.label)
        snapshot("host-round2-first-ping")
        try write("r2-first-ping.txt", ping2.label)
        tap(app.buttons["game.photoCatch"])
        takePhoto(app)
        tap(app.buttons["capture.submit"], timeout: 20)
        let back2 = app.buttons["capture.backToMap"]
        XCTAssertTrue(back2.waitForExistence(timeout: 60))
        try write("r2-claim-submitted.txt", "ok")
        back2.tap()
        let outcome2 = app.staticTexts["recap.outcome"]
        XCTAssertTrue(outcome2.waitForExistence(timeout: 600), "round 2 should complete")
        snapshot("host-round2-recap")
        try write("host-r2-done.txt", outcome2.label)
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
        allowSystemAlerts(app)
        snapshot("seeker-lobby-ready")

        let phase = app.staticTexts["game.phase"]
        XCTAssertTrue(phase.waitForExistence(timeout: 300), "round should start")
        snapshot("seeker-head-start")
        // No ping may exist during the head start.
        XCTAssertFalse(app.staticTexts["game.lastPing"].exists, "no hider location before the first scheduled ping")

        let lastPing = app.staticTexts["game.lastPing"]
        XCTAssertTrue(lastPing.waitForExistence(timeout: 150), "first ping should release when the head start ends")
        XCTAssertTrue(phase.label.localizedCaseInsensitiveContains("chase"), phase.label)
        snapshot("seeker-first-ping")
        try write("first-ping.txt", lastPing.label)

        XCTAssertTrue(lastPing.label.contains("#0"), lastPing.label)
        // Wait for the second scheduled ping (60 s interval in UI-test rules).
        waitUntil(timeout: 120) { lastPing.label.contains("#1") }
        snapshot("seeker-second-ping")
        try write("second-ping.txt", lastPing.label)

        tap(app.buttons["game.photoCatch"])
        takePhoto(app)
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

        // ---- Round 2: this crew now HIDES. Wait for the host to set it up.
        let ready2 = app.buttons["lobby.ready"]
        XCTAssertTrue(ready2.waitForExistence(timeout: 300), "round 2 lobby should appear when the host sets it up")
        waitUntil(ready2, enabled: true, timeout: 60)
        ready2.tap()
        snapshot("seeker-round2-ready")
        let phase2 = app.staticTexts["game.phase"]
        XCTAssertTrue(phase2.waitForExistence(timeout: 300), "round 2 should start")
        XCTAssertTrue(phase2.label.localizedCaseInsensitiveContains("hiding"), "this crew hides in round 2: \(phase2.label)")
        snapshot("seeker-round2-hiding")
        XCUIDevice.shared.press(.home) // hide with the phone "in a pocket"
        _ = try waitForFile("r2-claim-submitted.txt", timeout: 900)
        app.activate()
        let confirm = app.buttons["confirm.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 60))
        snapshot("seeker-round2-confirm")
        confirm.tap()
        let outcome2 = app.staticTexts["recap.outcome"]
        XCTAssertTrue(outcome2.waitForExistence(timeout: 90))
        snapshot("seeker-round2-recap")
        try write("seeker-r2-done.txt", outcome2.label)
    }

    // MARK: Helpers

    private func require(role: String) throws {
        guard env["MH_E2E_ROLE"] == role else { throw XCTSkip("Two-phone E2E (\(role)) runs only via scripts/e2e-two-simulators.sh") }
    }

    private func launch() -> XCUIApplication {
        installAlertMonitor()
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
            let t = app.buttons[id]
            // Form rows load lazily: scroll first, then assert.
            scrollTo(t, in: app)
            XCTAssertTrue(t.waitForExistence(timeout: 5), "missing \(id)")
            check(t)
        }
        let accept = app.buttons["consent.accept"]
        scrollTo(accept, in: app)
        for id in ["consent.t1", "consent.t2", "consent.t3"] where app.buttons[id].exists { check(app.buttons[id]) }
        waitUntil(accept, enabled: true, timeout: 10)
        accept.tap()
    }

    /// iOS offers to save the typed password; the sheet is exposed in the app's own
    /// hierarchy. (Querying SpringBoard directly wedges XCTest on iOS 27 simulators.)
    private func dismissSavePasswordPrompt(_ app: XCUIApplication) {
        RunLoop.current.run(until: Date().addingTimeInterval(2.5))
        let notNow = app.buttons["Not Now"]
        if notNow.exists { notNow.tap() }
    }

    /// System permission alerts (notifications, location) are handled by an interruption
    /// monitor; it fires on the next interaction with the app.
    private func installAlertMonitor() {
        addUIInterruptionMonitor(withDescription: "System permission alerts") { alert in
            for label in ["Allow While Using App", "Allow", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    /// Tap a CheckRow until it reports "Checked" (a scroll gesture can toggle it back).
    private func check(_ e: XCUIElement) {
        for _ in 0..<3 where (e.value as? String) != "Checked" {
            e.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        XCTAssertEqual(e.value as? String, "Checked")
    }

    /// Simulators either expose a simulated camera (UIImagePickerController) or none
    /// (DEBUG-only synthetic photo button). Handle both.
    private func takePhoto(_ app: XCUIApplication) {
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if app.buttons["capture.simPhoto"].exists { app.buttons["capture.simPhoto"].tap(); return }
            for id in ["PhotoCapture", "Take Picture"] where app.buttons[id].exists {
                app.buttons[id].tap()
                let use = app.buttons["Use Photo"]
                XCTAssertTrue(use.waitForExistence(timeout: 15), "camera should offer Use Photo")
                use.tap()
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        XCTFail("no camera or simulator photo option appeared")
    }

    private func allowSystemAlerts(_ app: XCUIApplication) {
        // Nudge the app so pending interruption monitors (location, then notifications) can run.
        for _ in 0..<2 {
            RunLoop.current.run(until: Date().addingTimeInterval(2))
            app.swipeDown(velocity: .slow)
        }
    }

    private func tap(_ e: XCUIElement, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing \(e)", file: file, line: line)
        waitUntil(e, enabled: true, timeout: timeout)
        e.tap()
    }

    /// Scroll until the element sits comfortably inside the screen (clear of the
    /// home-indicator gesture zone and the navigation bar), using short drags.
    /// Buttons pinned in a bottom action bar already sit above the home indicator.
    private func scrollTo(_ e: XCUIElement, in app: XCUIApplication) {
        let window = app.windows.firstMatch.frame
        for _ in 0..<15 {
            if e.exists && e.isHittable && e.frame.maxY < window.maxY - 44 && e.frame.minY > window.minY + 90 { return }
            // Plain swipes (no press-and-hold) so rows, steppers and menu pickers aren't activated.
            let up = !e.exists || e.frame.maxY >= window.maxY - 44
            if up { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
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
