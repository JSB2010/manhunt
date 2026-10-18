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
            let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
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
    func plan(for view: SessionViewDoc?, clock: ServerClock) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["mh.chase", "mh.ping", "mh.timecap"])
        guard authorized, let round = view?.round, round.state.isActive, round.state != .PAUSED else { return }
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
            schedule("mh.ping", at: round.nextPingAt, title: "Ping due", body: "A scheduled hiding-crew ping is due. Open the app to see if it was released.")
        }
    }

    func clearAll() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
