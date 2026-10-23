import Foundation
import UserNotifications
import UIKit
import FirebaseMessaging

/// Notifications are supplementary (spec §14): Firestore view updates and
/// server timers drive the game. Local notifications are scheduled from
/// server timestamps as a best-effort nudge; remote push (FCM → APNs) needs the
/// paid program and is gated by MH_ENABLE_PUSH. No notification ever contains
/// coordinates.
@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate, MessagingDelegate {
    private(set) var authorized = false
    private var api: APIClient?
    private let env: AppEnvironment
    /// Tapping a night's notification opens that night (where tracking starts if a round is on).
    var onOpenSession: ((String) -> Void)?

    init(env: AppEnvironment) {
        self.env = env
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    func attach(api: APIClient) { self.api = api }

    func refreshStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    }

    @discardableResult
    func requestAuthorization() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        authorized = granted
        if granted && env.pushEnabled {
            UIApplication.shared.registerForRemoteNotifications()
            Messaging.messaging().delegate = self
        }
        return granted
    }

    // MARK: Remote push (paid program only)

    func didRegister(deviceToken: Data) {
        guard env.pushEnabled else { return }
        Messaging.messaging().apnsToken = deviceToken
    }

    nonisolated func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken else { return }
        Task { @MainActor in
            let deviceId = AppEnvironment.deviceId
            #if DEBUG
            let envName = "development"
            #else
            let envName = "production"
            #endif
            try? await self.api?.registerPushToken(deviceId: deviceId, token: fcmToken, environment: envName, appVersion: AppEnvironment.current.appVersion)
        }
    }

    // MARK: Local deadline nudges

    /// Re-plan local notifications for the current round from server timestamps.
    /// `liveActivityAlerts`: the round's Live Activity gets these moments as pushed alerts,
    /// so a local nudge would say the same thing twice (HIG › Live Activities).
    func plan(for view: SessionViewDoc?, clock: ServerClock, liveActivityAlerts: Bool = false) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["mh.chase", "mh.ping", "mh.timecap"])
        guard authorized, !liveActivityAlerts, let round = view?.round, round.state.isActive, round.state != .PAUSED else { return }
        func schedule(_ id: String, at serverDate: Date?, title: String, body: String) {
            guard let serverDate else { return }
            let local = clock.localDate(forServer: serverDate)
            let interval = local.timeIntervalSinceNow
            guard interval > 1 else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.interruptionLevel = .timeSensitive
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false)))
        }
        if round.state == .HEAD_START {
            schedule("mh.chase", at: round.headStartEndsAt, title: "The chase is on", body: round.myRole == .SEEKING ? "Head start is over. Open the app for the first ping." : "Seekers are now moving.")
        } else if round.state == .CHASE, round.myRole == .SEEKING {
            schedule("mh.ping", at: round.nextPingAt, title: "Ping due", body: "Open the map for the hiders' latest spot.")
        }
    }

    func clearAll() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    /// Pushes carry the night's id (never coordinates). A phone that missed the round's start —
    /// in a pocket since the last round — starts tracking as soon as it's tapped.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let sid = response.notification.request.content.userInfo["sessionId"] as? String, !sid.isEmpty else { return }
        await MainActor.run { self.onOpenSession?(sid) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // Local deadline nudges are for a phone in a pocket; the open app already shows the timers.
        if notification.request.identifier.hasPrefix("mh.") { return [] }
        return [.banner, .sound]
    }
}
