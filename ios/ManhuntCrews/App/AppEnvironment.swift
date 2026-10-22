import Foundation
import FirebaseCore
import FirebaseAuth
import FirebaseFirestore
import UIKit

/// Build-time configuration injected through xcconfig → Info.plist.
struct AppEnvironment: Sendable {
    let apiBaseURL: URL
    let useEmulators: Bool
    let devHost: String
    let firebaseProjectId: String
    let appleSignInEnabled: Bool
    let pushEnabled: Bool
    let flavor: String
    /// Name of the bundled Firebase client config (without `.plist`).
    let firebasePlist: String
    /// Hosting site with the privacy policy and support pages.
    let siteURL: URL?
    let configurationError: String?

    var privacyPolicyURL: URL? { siteURL?.appendingPathComponent("privacy") }
    var supportURL: URL? { siteURL?.appendingPathComponent("support") }

    static let current: AppEnvironment = {
        let info = Bundle.main.infoDictionary ?? [:]
        func str(_ k: String) -> String { (info[k] as? String) ?? "" }
        func flag(_ k: String) -> Bool { ["YES", "TRUE", "1"].contains(str(k).uppercased()) }
        var error: String?
        let url = URL(string: str("MHApiBaseURL"))
        if url == nil || url?.host == nil || url?.host == "api.invalid" { error = "API base URL is not configured (MH_API_BASE_URL)." }
        let useEmulators = flag("MHUseEmulators")
        #if !DEBUG
        if useEmulators { error = "Release builds must not use the Firebase emulators." }
        #endif
        return AppEnvironment(
            apiBaseURL: url ?? URL(string: "http://127.0.0.1:8787")!,
            useEmulators: useEmulators,
            devHost: str("MHDevHost").isEmpty ? "127.0.0.1" : str("MHDevHost"),
            firebaseProjectId: str("MHFirebaseProjectId"),
            appleSignInEnabled: flag("MHEnableAppleSignIn"),
            pushEnabled: flag("MHEnablePush"),
            flavor: str("MHBuildFlavor"),
            firebasePlist: str("MHFirebasePlist").isEmpty ? "GoogleService-Info" : str("MHFirebasePlist"),
            siteURL: URL(string: str("MHSiteURL")).flatMap { $0.host == nil ? nil : $0 },
            configurationError: error)
    }()

    /// Stable id of this install, shared by the push token and Live Activity registrations
    /// (the server pairs an activity token with the device's FCM token by it).
    @MainActor static var deviceId: String {
        if let id = UIDevice.current.identifierForVendor?.uuidString { return id }
        let key = "mh.deviceId"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(v) (\(b))"
    }

    /// Configure Firebase. Emulator builds use a local demo project and never
    /// talk to production; release builds require GoogleService-Info.plist.
    @discardableResult
    func configureFirebase() -> String? {
        guard FirebaseApp.app() == nil else { return nil }
        if useEmulators {
            let opts = FirebaseOptions(googleAppID: "1:1234567890:ios:0123456789abcdef", gcmSenderID: "1234567890")
            opts.projectID = firebaseProjectId.isEmpty ? "demo-manhunt" : firebaseProjectId
            opts.apiKey = "AIzaSyDemoKeyForLocalEmulatorUseOnly000"
            opts.bundleID = Bundle.main.bundleIdentifier ?? "com.manhuntcrews.dev"
            FirebaseApp.configure(options: opts)
            Auth.auth().useEmulator(withHost: devHost, port: 9099)
            let settings = Firestore.firestore().settings
            settings.host = "\(devHost):8085"
            settings.isSSLEnabled = false
            settings.cacheSettings = MemoryCacheSettings()
            Firestore.firestore().settings = settings
            return nil
        }
        guard let path = Bundle.main.path(forResource: firebasePlist, ofType: "plist"),
              let opts = FirebaseOptions(contentsOfFile: path) else {
            return "\(firebasePlist).plist is missing. Add it for your Firebase project (it is git-ignored)."
        }
        FirebaseApp.configure(options: opts)
        let settings = Firestore.firestore().settings
        // Views contain only sanitized, role-scoped state; keep the cache in memory anyway.
        settings.cacheSettings = MemoryCacheSettings()
        Firestore.firestore().settings = settings
        return nil
    }
}
