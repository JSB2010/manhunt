import Foundation
import Observation
import SwiftUI
import UIKit
import FirebaseFirestore

enum DeepLink: Equatable {
    case join(code: String)
    case friend(token: String)

    init?(url: URL) {
        guard url.scheme == "manhuntcrews", let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let q = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        switch url.host {
        case "join": if let c = q["code"], !c.isEmpty { self = .join(code: c) } else { return nil }
        case "friend": if let t = q["token"], !t.isEmpty { self = .friend(token: t) } else { return nil }
        default: return nil
        }
    }
}

/// Root application state: auth, the open session's live view, and the
/// reconciliation between server phase and on-device tracking.
@MainActor
@Observable
final class AppModel {
    let env: AppEnvironment
    let api: APIClient
    let auth: AuthService
    let location: LocationTrackingCoordinator
    let notifications: NotificationService
    let clock = ServerClock.shared

    var me: MeResponse?
    var meError: String?
    var firebaseError: String?

    // Open session
    private(set) var activeSessionId: String?
    private(set) var sessionView: SessionViewDoc?
    private(set) var viewFromCache = false
    private(set) var viewError: String?
    private let listener = SessionViewListener()
    private var lastStateVersion: Double = 0
    private var lastSnapshotAt = Date.distantPast
    private var reconcileTask: Task<Void, Never>?

    var pendingDeepLink: DeepLink?
    var toast: String?

    init(env: AppEnvironment = .current) {
        self.env = env
        self.api = APIClient(baseURL: env.apiBaseURL)
        self.auth = AuthService(env: env)
        self.location = LocationTrackingCoordinator()
        self.notifications = NotificationService(env: env)
        firebaseError = env.configureFirebase()
        let auth = self.auth
        api.tokenProvider = { force in try await auth.idToken(forceRefresh: force) }
        location.attach(api: api)
        notifications.attach(api: api)
        if firebaseError == nil { auth.start() }
    }

    // MARK: Session lifecycle

    func onSignedIn() async {
        await api.syncTime()
        await refreshMe()
        await notifications.refreshStatus()
        if let resumed = await location.resumeIfNeeded() {
            openSession(resumed.sessionId)
        } else if activeSessionId == nil, let active = me?.activeSessions.first(where: { $0.status == "IN_ROUND" }) {
            openSession(active.id)
        }
    }

    func refreshMe() async {
        do {
            me = try await api.me()
            meError = nil
        } catch APIError.unauthenticated {
            // The stored session is no longer valid (expired refresh token, deleted
            // account, or a reset backend). Don't strand the user on an error screen.
            await signOut()
            show("Your session expired — please sign in again.")
        } catch {
            meError = error.localizedDescription
        }
    }

    func openSession(_ id: String) {
        guard let uid = auth.uid else { return }
        if activeSessionId != id {
            sessionView = nil
            lastStateVersion = 0
        }
        activeSessionId = id
        viewError = nil
        startListener(id: id, uid: uid)
        // Fetch immediately over REST too (fast first paint + server-clock sync).
        Task { await reloadSessionView() }
        startReconcileLoop()
    }

    private func startListener(id: String, uid: String) {
        lastSnapshotAt = Date()
        listener.start(sessionId: id, uid: uid) { [weak self] update in
            self?.lastSnapshotAt = Date()
            self?.handle(update)
        }
    }

    /// The Firestore listener is the fast path, but long-lived streams can die
    /// silently (mobile handoffs, proxies, emulator resets) while the SDK still
    /// believes it is connected. Reconcile over REST on a short cadence and
    /// restart the listener (with a network reset) when it has gone quiet, so the
    /// screen never shows a stale phase for long. Ordering by `stateVersion`
    /// prevents a REST response from overwriting newer listener state.
    private func startReconcileLoop() {
        reconcileTask?.cancel()
        reconcileTask = Task { [weak self] in
            while !Task.isCancelled {
                let foreground = UIApplication.shared.applicationState == .active
                try? await Task.sleep(nanoseconds: (foreground ? 10 : 30) * 1_000_000_000)
                guard let self, !Task.isCancelled, let id = self.activeSessionId, let uid = self.auth.uid else { return }
                await self.reloadSessionView()
                if Date().timeIntervalSince(self.lastSnapshotAt) > 60 {
                    realtimeLog.info("listener quiet for 60s — restarting stream")
                    let db = Firestore.firestore()
                    try? await db.disableNetwork()
                    try? await db.enableNetwork()
                    self.startListener(id: id, uid: uid)
                }
            }
        }
    }

    func reloadSessionView() async {
        guard let id = activeSessionId else { return }
        do {
            let v = try await api.session(id)
            apply(v, fromCache: false)
        } catch let e as APIError where e.code == "NOT_FOUND" {
            viewError = "This night is no longer available."
            await location.stop()
        } catch {
            viewError = error.localizedDescription
        }
    }

    func closeSession() {
        realtimeLog.info("closeSession")
        reconcileTask?.cancel()
        reconcileTask = nil
        listener.stop()
        activeSessionId = nil
        sessionView = nil
        Task { await refreshMe() }
    }

    private func handle(_ update: SessionViewListener.Update) {
        if let error = update.error {
            viewFromCache = true
            viewError = "Live updates interrupted: \(error.localizedDescription)"
            return
        }
        viewFromCache = update.fromCache
        if let v = update.view { apply(v, fromCache: update.fromCache) }
    }

    private func apply(_ v: SessionViewDoc, fromCache: Bool) {
        guard v.sessionId == activeSessionId else { return }
        // Ignore out-of-order renders (REST vs. listener).
        if v.stateVersion < lastStateVersion {
            realtimeLog.info("view dropped (older) v=\(v.stateVersion, privacy: .public) last=\(self.lastStateVersion, privacy: .public)")
            return
        }
        realtimeLog.info("view applied v=\(v.stateVersion, privacy: .public) state=\(v.round?.state.rawValue ?? "-", privacy: .public) cache=\(fromCache)")
        lastStateVersion = v.stateVersion
        sessionView = v
        viewError = nil
        if !fromCache {
            Task { await reconcileTracking(v) }
            notifications.plan(for: v, clock: clock)
        }
    }

    /// Server phase decides whether this device records GPS — never a local timer.
    private func reconcileTracking(_ v: SessionViewDoc) async {
        guard let round = v.round, let role = round.myRole, !v.session.revoked else {
            if location.mode != .idle { await location.stop() }
            return
        }
        if round.state.isActive, let start = round.roundStartAt {
            await location.beginTracking(sessionId: v.sessionId, roundId: round.id, role: role, roundStartAt: start)
        } else if round.state == .READY, let myTeam = v.session.myTeam, round.isReady(myTeam) {
            if location.mode == .idle { await location.beginPreflight(sessionId: v.sessionId, roundId: round.id, role: role) }
        } else if location.mode != .idle {
            await location.stop()
        }
    }

    // MARK: Account

    func signOut() async {
        await location.purgeLocalData()
        notifications.clearAll()
        closeSession()
        EncryptedStore.purgeAll()
        try? auth.signOut()
        me = nil
    }

    func handle(url: URL) {
        if let link = DeepLink(url: url) { pendingDeepLink = link }
    }

    func show(_ message: String) {
        toast = message
        Task { try? await Task.sleep(nanoseconds: 3_500_000_000); if toast == message { toast = nil } }
    }
}
