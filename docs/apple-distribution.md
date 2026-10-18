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
2. `cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig`; set `MH_DEVELOPMENT_TEAM`, a unique `MH_BUNDLE_ID`, and `MH_DEV_HOST` = your Mac's LAN IP.
3. Run the local stack reachable from the LAN: `API_HOST=0.0.0.0 scripts/dev.sh` (the Firebase emulators already bind 0.0.0.0). Seed demo accounts: `cd backend && npm run seed:emulator`.
4. Open `ios/ManhuntCrews.xcodeproj`, choose your iPhone, Run. On the phone: Settings → General → VPN & Device Management → trust your developer certificate. Allow Local Network access when prompted.
5. Repeat on the second iPhone (each operator needs one).

Limits (Apple): Personal Team profiles expire after **7 days** (rebuild/reinstall), a small device limit, and **no Push Notifications or Sign in with Apple entitlements**. The app gates both behind flags: auth uses Firebase email/password (`DEV_AUTH_PROVIDER`), and notifications fall back to local deadline nudges. Background location works (Background Modes → Location updates is in `Info.plist`; no paid entitlement needed).

## Phase B — paid Apple Developer Program ($99/yr), private TestFlight
Required from the program account holder (must meet Apple's eligibility, including age of majority):
1. Enroll; create App ID for `MH_BUNDLE_ID` with **Push Notifications** and **Sign in with Apple** capabilities.
2. Create an **APNs Auth Key (.p8)**; upload it in Firebase Console → Project settings → Cloud Messaging (never commit it).
3. Firebase Console → Authentication → enable **Apple** provider (Services ID/team/key as Firebase documents) and keep Email/Password enabled for the account-linking path.
4. Download `GoogleService-Info.plist` for the iOS app into `ios/ManhuntCrews/` (git-ignored).
5. In `Local.xcconfig` for release builds: `MH_ENABLE_PUSH = YES`, `MH_ENABLE_APPLE_SIGN_IN = YES`, `MH_ENTITLEMENTS = ManhuntCrews/ManhuntCrews-Distribution.entitlements`, `MH_USE_EMULATORS = NO`, `MH_API_BASE_URL = https:/$()/<your Cloud Run API URL>`.
6. Product → Archive → Distribute → App Store Connect → upload. In App Store Connect create the app record, fill privacy details (precise location linked to identity, photos, user content; used for app functionality; not tracking), then add **external testers** (only the friends who operate phones). External TestFlight may require Beta App Review; builds expire after **90 days**.

Sign in with Apple links to the same Firebase UID when a signed-in email user adds Apple (`AuthService.completeApple` → `user.link`).

## Phase C — longer term
Continue periodic TestFlight uploads or consider an unlisted App Store release. Do **not** use the Enterprise program for a friend group. Ad Hoc distribution is possible with the paid program but requires registering each device UDID.

## App Review / privacy strings
`Info.plist` declares: `NSLocationWhenInUseUsageDescription` (round-only, screen-locked tracking, scheduled pings, post-round routes), `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationTemporaryUsageDescriptionDictionary[RoundTracking]`, `NSCameraUsageDescription` (catch photos, bystanders, metadata removed), `NSLocalNetworkUsageDescription` (development only), `UIBackgroundModes = location, remote-notification`.
