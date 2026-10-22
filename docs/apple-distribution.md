# iOS signing & distribution

Configuration lives in `ios/Config/*.xcconfig`; put personal values in `ios/Config/Local.xcconfig` (git-ignored, see `Local.xcconfig.example`).

| Setting | Purpose |
|---|---|
| `MH_DEVELOPMENT_TEAM` | Your Apple team ID (Personal Team works for phase A) |
| `MH_BUNDLE_ID` | Must be unique to you, e.g. `com.yourname.manhuntcrews` |
| `MH_DEV_HOST` | Debug: host running `scripts/dev.sh` (simulator: `127.0.0.1`; iPhone: your Mac's LAN IP) |
| `MH_USE_EMULATORS` / `MH_API_BASE_URL` | Debug defaults to emulators + local API; Release requires a deployed API URL |
| `MH_ENABLE_PUSH`, `MH_ENABLE_APPLE_SIGN_IN`, `MH_ENTITLEMENTS` | Paid-program features (see phase B) |

## Phase A — free Personal Team, your own iPhones (works today)
1. Xcode → Settings → Accounts → add your Apple ID (Personal Team).
2. `cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig`, then set `MH_DEVELOPMENT_TEAM`, `MH_BUNDLE_ID` if you need a unique one, and `MH_DEV_HOST` = your Mac's LAN IP (`ipconfig getifaddr en0`). Keep the team ID here: if Xcode's Signing pane writes `DEVELOPMENT_TEAM` into `project.pbxproj`, revert that edit.
3. Run the local stack: `scripts/dev.sh`. The API and the Firebase emulators already listen on all interfaces. Seed demo accounts with `cd backend && npm run seed:emulator`. With the macOS firewall on, click **Allow** when macOS asks whether `java` (the Firestore emulator on JDK 21) and `node` may accept incoming connections. From another device on the Wi-Fi, `http://<Mac IP>:8787/healthz` should return `{"ok":true,…}`.
4. Choose your iPhone in Xcode and Run, or from the command line: `xcodebuild build -project ios/ManhuntCrews.xcodeproj -scheme ManhuntCrews -destination "id=<device UDID>" -allowProvisioningUpdates`, then `xcrun devicectl device install app --device <UDID> <path to ManhuntCrews.app>` (`xcrun devicectl list devices` shows the UDID). On the phone, trust the developer certificate the first time (Settings → General → VPN & Device Management) and **allow Local Network access** when prompted.
5. Repeat on every other iPhone that will play. Each crew needs at least one. Rebuild after changing `MH_DEV_HOST`, because the address is compiled into Debug builds.

**Same Wi-Fi only.** A phone on cellular can't reach your Mac's LAN address, so this setup is for indoor and nearby testing. For the outdoor two-phone protocol, use a deployed dev backend (`docs/deployment.md`, which needs your approval and a billing account), or put the Mac and both phones on a private mesh VPN and set `MH_DEV_HOST` to the Mac's VPN address. The VPN option is unverified here: check ATS and Local Network behavior with that address first.

Limits (Apple): Personal Team profiles expire after **7 days** (rebuild/reinstall), a small device limit, and **no Push Notifications or Sign in with Apple entitlements**. The app gates both behind flags: auth uses Firebase email/password, and notifications fall back to local deadline nudges. The Live Activity still runs: the app starts and updates it while it tracks (ADR 0017). Background location works (Background Modes → Location updates is in `Info.plist`; no paid entitlement needed).

## Phase B — paid Apple Developer Program ($99/yr), private TestFlight
**Current path:** the **Prod** build configuration with manual signing (no Apple ID in Xcode) and `scripts/ios-signing.sh` + `scripts/ios-release.sh`. Follow [`docs/release-prod.md`](release-prod.md). The steps below are the general reference.

Required from the program account holder (must meet Apple's eligibility, including age of majority):
1. Enroll; create App ID for `MH_BUNDLE_ID` with **Push Notifications** and **Sign in with Apple** capabilities.
2. Create an **APNs Auth Key (.p8)**; upload it in Firebase Console → Project settings → Cloud Messaging (never commit it).
3. Firebase Console → Authentication → enable **Apple** provider (Services ID/team/key as Firebase documents) and keep Email/Password enabled for the account-linking path.
4. Download `GoogleService-Info.plist` for the iOS app into `ios/ManhuntCrews/` (git-ignored).
5. In `Local.xcconfig` for release builds: `MH_ENABLE_PUSH = YES`, `MH_ENABLE_APPLE_SIGN_IN = YES`, `MH_ENTITLEMENTS = ManhuntCrews/ManhuntCrews-Distribution.entitlements`, `MH_USE_EMULATORS = NO`, `MH_API_BASE_URL = https:/$()/<your api function URL>`.
6. Product → Archive → Distribute → App Store Connect → upload. In App Store Connect create the app record, fill privacy details (precise location linked to identity, photos, user content; used for app functionality; not tracking), then add **external testers** (only the friends who operate phones). External TestFlight may require Beta App Review; builds expire after **90 days**.

Sign in with Apple links to the same Firebase UID when a signed-in email user adds Apple (`AuthService.completeApple` → `user.link`).

## Phase C — longer term
Continue periodic TestFlight uploads or consider an unlisted App Store release. Do **not** use the Enterprise program for a friend group. Ad Hoc distribution is possible with the paid program but requires registering each device UDID.

## App Review / privacy strings
`Info.plist` declares: `NSLocationWhenInUseUsageDescription` (round-only, screen-locked tracking, scheduled pings, post-round routes), `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationTemporaryUsageDescriptionDictionary[RoundTracking]`, `NSCameraUsageDescription` (catch photos, bystanders, metadata removed), `NSLocalNetworkUsageDescription` (development only), `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates` (ADR 0017), `UIBackgroundModes = location, remote-notification`, and `ITSAppUsesNonExemptEncryption = NO`.
