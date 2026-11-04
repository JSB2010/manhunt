import XCTest
import UserNotifications
@testable import ManhuntCrews

/// `UNNotification` and `UNNotificationResponse` have no public initializer. This archives a
/// stand-in under the real class's name, so the real class decodes itself from these fields.
@objc(MHArchivedStandIn)
private final class ArchivedStandIn: NSObject, NSCoding {
    private let fields: [String: Any]
    init(_ fields: [String: Any]) { self.fields = fields }
    required init?(coder: NSCoder) { nil }
    func encode(with coder: NSCoder) { fields.forEach { coder.encode($0.value, forKey: $0.key) } }
}

private func decoded<T: NSObject>(_ type: T.Type, fields: [String: Any]) throws -> T {
    let archiver = NSKeyedArchiver(requiringSecureCoding: false)
    archiver.setClassName(NSStringFromClass(T.self), for: ArchivedStandIn.self)
    archiver.encode(ArchivedStandIn(fields), forKey: NSKeyedArchiveRootObjectKey)
    archiver.finishEncoding()
    let unarchiver = try NSKeyedUnarchiver(forReadingFrom: archiver.encodedData)
    unarchiver.requiresSecureCoding = false
    return try XCTUnwrap(unarchiver.decodeObject(forKey: NSKeyedArchiveRootObjectKey) as? T)
}

private func notification(userInfo: [AnyHashable: Any]) throws -> UNNotification {
    let content = UNMutableNotificationContent()
    content.title = "Test"
    content.userInfo = userInfo
    let request = UNNotificationRequest(identifier: "test", content: content, trigger: nil)
    return try decoded(UNNotification.self, fields: ["date": Date(), "request": request])
}

/// UIKit aborts when a tap's completion handler runs off the main thread with the app in the
/// background or closed. These call the Objective-C entry point, the way the system does.
/// Debug fails on every path if the handler leaves the main actor; optimized builds have crashed
/// only on the path with no night id, so a pass here is what guards both.
@MainActor
final class NotificationTapTests: XCTestCase {
    private var service: NotificationService!
    private var previousDelegate: UNUserNotificationCenterDelegate?

    override func setUp() async throws {
        previousDelegate = UNUserNotificationCenter.current().delegate
        service = NotificationService(env: .current)
    }

    override func tearDown() async throws {
        UNUserNotificationCenter.current().delegate = previousDelegate
        service = nil
    }

    private func tap(userInfo: [AnyHashable: Any]) async throws -> (onMain: Bool, opened: [String]) {
        var opened: [String] = []
        service.onOpenSession = { opened.append($0) }
        let response = try decoded(UNNotificationResponse.self, fields: [
            "notification": try notification(userInfo: userInfo),
            "actionIdentifier": UNNotificationDefaultActionIdentifier,
        ])
        XCTAssertEqual(response.notification.request.content.userInfo.count, userInfo.count, "the response should carry this payload")

        let done = expectation(description: "completion handler called")
        var onMain = false
        let delegate: UNUserNotificationCenterDelegate = service
        delegate.userNotificationCenter?(UNUserNotificationCenter.current(), didReceive: response, withCompletionHandler: {
            onMain = Thread.isMainThread
            done.fulfill()
        })
        await fulfillment(of: [done], timeout: 5)
        return (onMain, opened)
    }

    func testTapWithNightCompletesOnMainThreadAndOpensIt() async throws {
        let result = try await tap(userInfo: ["sessionId": "night-1"])
        XCTAssertTrue(result.onMain, "completing off the main thread aborts the app")
        XCTAssertEqual(result.opened, ["night-1"])
    }

    /// Local deadline nudges ("The chase is on", "Ping due") carry no night id.
    func testTapWithoutNightCompletesOnMainThreadAndOpensNothing() async throws {
        let result = try await tap(userInfo: [:])
        XCTAssertTrue(result.onMain, "completing off the main thread aborts the app")
        XCTAssertEqual(result.opened, [])
    }

    /// A tap that launches the app arrives before Auth's first callback. Home opens it once signed in.
    func testTapBeforeAuthReportsIsKeptForHome() {
        let model = AppModel(env: .current)
        XCTAssertEqual(model.auth.state, .unknown)
        model.notifications.onOpenSession?("night-1")
        XCTAssertEqual(model.pendingDeepLink, .round(sessionId: "night-1"))
        XCTAssertNil(model.activeSessionId)
    }

    func testPresentingCompletesOnMainThread() async throws {
        let done = expectation(description: "completion handler called")
        var onMain = false
        let delegate: UNUserNotificationCenterDelegate = service
        delegate.userNotificationCenter?(UNUserNotificationCenter.current(), willPresent: try notification(userInfo: [:]), withCompletionHandler: { _ in
            onMain = Thread.isMainThread
            done.fulfill()
        })
        await fulfillment(of: [done], timeout: 5)
        XCTAssertTrue(onMain, "system completion handlers belong on the main thread")
    }
}
