import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    var model: AppModel?

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in self.model?.notifications.didRegister(deviceToken: deviceToken) }
    }
}

@main
struct ManhuntCrewsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onAppear { delegate.model = model }
                .onOpenURL { model.handle(url: $0) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active, model.activeSessionId != nil {
                        // Reconnect: fetch the authoritative phase/timers; never trust a local clock.
                        Task { await model.api.syncTime(); await model.reloadSessionView() }
                    }
                }
        }
    }
}
