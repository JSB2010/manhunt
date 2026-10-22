import ActivityKit
import Foundation
import Observation
import UIKit
import os

let liveActivityLog = Logger(subsystem: "com.manhuntcrews", category: "live-activity")

/// The round's Live Activity on this phone (ADR 0017).
///
/// - Starts when a round this phone plays is under way and the app is in the foreground
///   (ActivityKit only starts activities from the foreground; a round another phone starts
///   arrives as a push-to-start instead).
/// - Updates from every applied server view, only when the content changed. Between
///   updates the system runs the timers itself.
/// - Ends with the round's final state and leaves the Lock Screen after 15 minutes.
/// - With push enabled, each activity's push token goes to the server, which keeps the
///   activity current while the app is suspended and sends the round's alerts on it.
///
/// Like notifications, it is supplementary: game state and timing never depend on it.
@MainActor
@Observable
final class LiveActivityController {
    typealias Attributes = RoundActivityAttributes

    /// An ended round stays on the Lock Screen this long (HIG: 15–30 minutes; server: LIVE_ACTIVITY_DISMISS_AFTER_MS).
    static let dismissAfter: TimeInterval = 15 * 60
    /// Re-register when the phone's clock offset drifts more than this from the one the server uses.
    static let offsetTolerance: Double = 1_000

    private static let enabledKey = "liveActivities.enabled"
    private static let dismissedKey = "liveActivities.dismissedRounds"

    /// The in-app switch (Settings). Off: no new activities, running ones end, and the server
    /// stops push-starting them on this phone.
    var enabled: Bool {
        didSet {
            guard enabled != oldValue else { return }
            UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
            Task { await enabledChanged() }
        }
    }
    /// Live Activities allowed for the app in iOS Settings.
    private(set) var systemAllowed = ActivityAuthorizationInfo().areActivitiesEnabled
    /// The current round has a running activity on this phone.
    private(set) var activeRoundId: String?

    private let env: AppEnvironment
    private let api: APIClient
    private let clock: ServerClock
    @ObservationIgnored private var started = false
    @ObservationIgnored private var lastView: SessionViewDoc?
    /// Reconciles run one after another, so two quick views can't both start an activity.
    @ObservationIgnored private var reconciling: Task<Void, Never>?
    /// activity id → its token and state observers
    @ObservationIgnored private var observers: [String: [Task<Void, Never>]] = [:]
    /// activity id → clock offset the server renders with (set when its token registers)
    @ObservationIgnored private var registeredOffset: [String: Double] = [:]
    /// activity id → latest push token (hex)
    @ObservationIgnored private var pushTokens: [String: String] = [:]
    @ObservationIgnored private var startToken: String?
    /// Rounds whose activity the person removed from the Lock Screen: not restarted.
    @ObservationIgnored private var dismissedRounds: [String]

    init(env: AppEnvironment, api: APIClient, clock: ServerClock) {
        self.env = env
        self.api = api
        self.clock = clock
        enabled = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
        dismissedRounds = UserDefaults.standard.stringArray(forKey: Self.dismissedKey) ?? []
    }

    /// Once per sign-in: adopt activities from an earlier launch or a push-to-start, and watch
    /// for new ones, the iOS setting and (with push) the push-to-start token.
    func start() {
        guard !started else { return }
        started = true
        systemAllowed = ActivityAuthorizationInfo().areActivitiesEnabled
        for activity in Activity<Attributes>.activities { adopt(activity) }
        Task { [weak self] in
            for await allowed in ActivityAuthorizationInfo().activityEnablementUpdates {
                guard let self else { return }
                self.systemAllowed = allowed
                if allowed, let v = self.lastView { await self.reconcile(with: v) }
            }
        }
        Task { [weak self] in
            for await activity in Activity<Attributes>.activityUpdates {
                // Push-started (another phone started the round) or started by this app.
                guard let self else { return }
                self.adopt(activity)
                if let v = self.lastView { await self.reconcile(with: v) }
            }
        }
        if env.pushEnabled, #available(iOS 17.2, *) {
            Task { [weak self] in
                for await data in Activity<Attributes>.pushToStartTokenUpdates {
                    guard let self else { return }
                    self.startToken = data.hexString
                    await self.sendStartToken()
                }
            }
        }
    }

    /// Bring the activity in line with an applied (non-cached) server view, or end it when
    /// the night closed (`nil`).
    func reconcile(with view: SessionViewDoc?) async {
        let previous = reconciling
        let next = Task { [weak self] in
            await previous?.value
            await self?.apply(view)
        }
        reconciling = next
        await next.value
    }

    private func apply(_ view: SessionViewDoc?) async {
        lastView = view
        let activities = Activity<Attributes>.activities
        guard let view, !view.session.revoked else {
            for a in activities where a.isRunning { await a.end(nil, dismissalPolicy: .immediate) }
            activeRoundId = nil
            return
        }
        guard let round = view.round else { return }
        // Anything left from another round or night is out of date: take it down.
        for a in activities where a.isRunning && (a.attributes.sessionId != view.sessionId || a.attributes.roundId != round.id) {
            await a.end(nil, dismissalPolicy: .immediate)
        }
        let mine = activities.first { $0.attributes.roundId == round.id && $0.attributes.sessionId == view.sessionId }
        guard let attributes = RoundActivityContent.attributes(for: view) else {
            // READY, or this phone isn't playing the round (anymore).
            if let mine, mine.isRunning { await mine.end(nil, dismissalPolicy: .immediate) }
            activeRoundId = nil
            return
        }
        let offset = mine.flatMap { registeredOffset[$0.id] } ?? currentOffsetMs
        guard let state = RoundActivityContent.state(for: round, clockOffsetMs: offset) else { return }
        let content = ActivityContent(state: state, staleDate: RoundActivityAttributes.ContentState.date(state.staleDate))

        if let mine {
            guard mine.isRunning else { return } // ended, or removed by the person
            if state.phase == .ENDED {
                await mine.end(content, dismissalPolicy: .after(Date().addingTimeInterval(Self.dismissAfter)))
                activeRoundId = nil
            } else {
                if mine.content.state != state { await mine.update(content) }
                activeRoundId = round.id
                await registerIfOffsetDrifted(mine)
            }
            return
        }

        guard state.phase != .ENDED, enabled, systemAllowed, !dismissedRounds.contains(round.id) else { return }
        // ActivityKit starts activities only from the foreground; the next foreground view starts it.
        guard UIApplication.shared.applicationState == .active else { return }
        do {
            let activity = try Activity.request(attributes: attributes, content: content, pushType: env.pushEnabled ? .token : nil)
            liveActivityLog.info("started live activity for round \(round.index, privacy: .public)")
            activeRoundId = round.id
            adopt(activity)
        } catch {
            // Limits reached, or turned off meanwhile: the game screen has everything.
            liveActivityLog.error("live activity start failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// The server carries this round's alerts on the activity, so local deadline nudges would repeat them.
    func carriesAlerts(roundId: String) -> Bool {
        Activity<Attributes>.activities.contains { a in a.attributes.roundId == roundId && a.isRunning && registeredOffset[a.id] != nil }
    }

    /// Hide this round's activity (game screen › Options). It stays hidden for the round.
    func dismissCurrent() async {
        guard let id = activeRoundId else { return }
        rememberDismissed(id)
        for a in Activity<Attributes>.activities where a.attributes.roundId == id { await a.end(nil, dismissalPolicy: .immediate) }
        activeRoundId = nil
    }

    /// Sign-out: end everything here and stop push-to-start for this device while the account is still signed in.
    func signOut() async {
        for a in Activity<Attributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
        if env.pushEnabled { try? await api.registerLiveActivityStartToken(deviceId: AppEnvironment.deviceId, token: nil) }
        activeRoundId = nil
        lastView = nil
        registeredOffset = [:]
        pushTokens = [:]
    }

    // MARK: Private

    private var currentOffsetMs: Double { (clock.deviceOffsetSeconds * 1000).rounded() }

    private func enabledChanged() async {
        if enabled {
            await sendStartToken()
            if let v = lastView { await reconcile(with: v) }
        } else {
            for a in Activity<Attributes>.activities where a.isRunning { await a.end(nil, dismissalPolicy: .immediate) }
            activeRoundId = nil
            await sendStartToken()
        }
    }

    private func sendStartToken() async {
        guard env.pushEnabled, let token = startToken else { return }
        do {
            try await api.registerLiveActivityStartToken(deviceId: AppEnvironment.deviceId, token: enabled && systemAllowed ? token : nil)
        } catch {
            liveActivityLog.error("push-to-start token upload failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Watch one activity's push token and state for as long as it lives.
    private func adopt(_ activity: Activity<Attributes>) {
        guard observers[activity.id] == nil else { return }
        // One activity per round: a push-to-start racing this phone's own start loses.
        let twins = Activity<Attributes>.activities.filter { $0.attributes.roundId == activity.attributes.roundId && $0.id != activity.id && $0.isRunning }
        if !twins.isEmpty, activity.isRunning {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            return
        }
        let id = activity.id
        let tokens = Task { [weak self] in
            guard self?.env.pushEnabled == true else { return }
            for await data in activity.pushTokenUpdates {
                guard let self else { return }
                self.pushTokens[id] = data.hexString
                await self.register(activity, offset: self.currentOffsetMs)
            }
        }
        let states = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard let self else { return }
                if state == .dismissed {
                    // Removed from the Lock Screen: respect that for the rest of the round.
                    self.rememberDismissed(activity.attributes.roundId)
                }
                if state == .dismissed || state == .ended {
                    await self.unregister(activity)
                    self.finish(id)
                    return
                }
            }
        }
        observers[id] = [tokens, states]
    }

    private func finish(_ id: String) {
        observers[id]?.forEach { $0.cancel() }
        observers[id] = nil
        registeredOffset[id] = nil
        pushTokens[id] = nil
    }

    private func register(_ activity: Activity<Attributes>, offset: Double) async {
        guard let token = pushTokens[activity.id], activity.isRunning else { return }
        do {
            try await api.registerLiveActivity(activity.attributes.sessionId, activity.attributes.roundId, deviceId: AppEnvironment.deviceId, pushToken: token, clockOffsetMs: Int(offset))
            registeredOffset[activity.id] = offset
        } catch {
            registeredOffset[activity.id] = nil
            liveActivityLog.error("live activity token upload failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func registerIfOffsetDrifted(_ activity: Activity<Attributes>) async {
        guard let registered = registeredOffset[activity.id], abs(registered - currentOffsetMs) > Self.offsetTolerance else { return }
        await register(activity, offset: currentOffsetMs)
    }

    private func unregister(_ activity: Activity<Attributes>) async {
        guard env.pushEnabled, registeredOffset[activity.id] != nil || pushTokens[activity.id] != nil else { return }
        try? await api.unregisterLiveActivity(activity.attributes.sessionId, activity.attributes.roundId, deviceId: AppEnvironment.deviceId)
    }

    private func rememberDismissed(_ roundId: String) {
        dismissedRounds = Array((dismissedRounds + [roundId]).suffix(20))
        UserDefaults.standard.set(dismissedRounds, forKey: Self.dismissedKey)
    }
}

private extension Activity {
    /// Still on screen and updatable (not ended or removed).
    var isRunning: Bool { activityState == .active || activityState == .stale }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
