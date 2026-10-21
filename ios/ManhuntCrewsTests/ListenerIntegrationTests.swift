import XCTest
import FirebaseAuth
@testable import ManhuntCrews

/// Runs against the LOCAL stack (scripts/dev.sh + seeded accounts); skips otherwise.
/// Verifies the iOS Firestore listener on `sessions/{sid}/views/{uid}` keeps
/// delivering every server-side change (join, consents, readiness).
final class ListenerIntegrationTests: XCTestCase {
    private struct Seed: Decodable { struct A: Decodable { let email: String; let password: String }; let accounts: [A] }

    private func seed() throws -> Seed {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("backend/scripts/seed-accounts.json")
        return try JSONDecoder().decode(Seed.self, from: Data(contentsOf: url))
    }

    private func reachable(_ api: URL) async -> Bool {
        (try? await URLSession.shared.data(from: api.appendingPathComponent("healthz")))?.1 != nil
    }

    private func restToken(email: String, password: String) async throws -> String {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password, "returnSecureToken": true])
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try JSONSerialization.jsonObject(with: data) as! [String: Any])["idToken"] as! String
    }

    @MainActor
    func testViewListenerDeliversEveryChange() async throws {
        let env = AppEnvironment.current
        guard env.useEmulators, await reachable(env.apiBaseURL) else { throw XCTSkip("local stack not running") }
        let s = try seed()
        env.configureFirebase()
        _ = try await Auth.auth().signIn(withEmail: s.accounts[0].email, password: s.accounts[0].password)
        let uid = Auth.auth().currentUser!.uid
        let host = APIClient(baseURL: env.apiBaseURL, clock: ServerClock())
        host.tokenProvider = { force in try await Auth.auth().currentUser!.getIDToken(forcingRefresh: force) }
        let guestToken = try await restToken(email: s.accounts[1].email, password: s.accounts[1].password)
        let guest = APIClient(baseURL: env.apiBaseURL, clock: ServerClock())
        guest.tokenProvider = { _ in guestToken }

        let created = try await host.createSession(CreateSessionBody(
            title: "listener probe", scheduledDate: "2026-10-18", myTeam: .A,
            teams: ["A": .init(name: "A", roster: []), "B": .init(name: "B", roster: [])], rules: RulesPatch(.defaults), groupId: nil))
        let sid = created.sessionId

        var received: [SessionViewDoc] = []
        let listener = SessionViewListener()
        listener.start(sessionId: sid, uid: uid) { update in
            if let v = update.view { received.append(v) }
            if let e = update.error { XCTFail("listener error \(e)") }
        }
        defer { listener.stop() }

        func waitFor(_ label: String, _ predicate: @escaping (SessionViewDoc) -> Bool) async throws {
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline {
                if let last = received.last, predicate(last) { return }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            XCTFail("listener did not deliver: \(label) (got \(received.count) snapshots)")
        }

        try await waitFor("initial") { $0.session.team(.B)?.hasPhone == false }
        let invite = try await host.nightCode(sid)
        _ = try await guest.redeemInvite(code: invite.code, teamKey: .B)
        try await waitFor("guest joined") { $0.session.team(.B)?.hasPhone == true }
        try await guest.consent(sid, accepted: true)
        try await waitFor("guest consent") { $0.session.team(.B)?.operators.first?.consentGiven == true }
        try await host.consent(sid, accepted: true)
        try await waitFor("host consent") { $0.session.team(.A)?.operators.first?.consentGiven == true }
        let health = HealthPayload(permission: "WHEN_IN_USE", preciseLocation: true, trackingActive: false, backgroundSessionActive: false, lowPowerMode: false, batteryLevel: nil, networkReachable: true, appVersion: nil, queuedSamples: 0, lastFixAgeSeconds: nil, lastFixAccuracyMeters: nil)
        try await guest.setReady(sid, ready: true, preflight: health)
        try await waitFor("guest ready") { $0.round?.isReady(.B) == true }
        try await Task.sleep(nanoseconds: 30_000_000_000) // idle period, then another change must still arrive
        try await host.setReady(sid, ready: true, preflight: health)
        try await waitFor("host ready after idle") { $0.round?.isReady(.A) == true }
        try? Auth.auth().signOut()
    }
}
