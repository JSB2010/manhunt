# Production release runbook (TestFlight)

*Signing is manual: nothing needs to be signed into Xcode. Your values (bundle ID, prod Firebase project, API and site URLs, signing team) live in `ios/Config/Prod.local.xcconfig`, which is git-ignored; start from `ios/Config/Prod.local.xcconfig.example`. Keep your own release log, key IDs and tester details in `docs/release-prod.local.md`, which is also git-ignored.*

Below, `<bundle-id>` is your `MH_BUNDLE_ID` and `<prod-project-id>` your Firebase project ID.

## 0. Firebase project and app config
1. Create a dedicated Firebase project. Create the Firestore `(default)` database (its region is permanent) and turn on delete protection.
2. Register the iOS app with `<bundle-id>` and download its config: `firebase apps:sdkconfig IOS --project <prod-project-id> -o ios/ManhuntCrews/GoogleService-Info-Prod.plist` (git-ignored).
3. Fill in `ios/Config/Prod.local.xcconfig` from the example.

## 1. Apple Developer portal (browser, developer.apple.com → Certificates, Identifiers & Profiles)
1. **Identifiers → +** → App IDs → App:
   - Description: Manhunt Crews
   - Bundle ID (Explicit): `<bundle-id>`
   - Capabilities: tick **Push Notifications**
   - Register
2. Create a signing request with `scripts/ios-signing.sh csr` (key and CSR in `~/.manhunt-signing/`; back up that folder). Then **Certificates → +** → **Apple Distribution** → upload `~/.manhunt-signing/distribution.csr` → Download (`distribution.cer`).
3. **Profiles → +** → Distribution → **App Store Connect**:
   - App ID: `<bundle-id>`
   - Certificate: the one from step 2
   - Name: exactly **Manhunt Crews App Store**
   - Download it.
   Then the Live Activity extension (ADR 0017) gets its own App ID and profile:
   - **Identifiers → +** → App IDs → App, Bundle ID (Explicit): `<bundle-id>.widgets`, no capabilities.
   - **Profiles → +** → Distribution → **App Store Connect**, App ID `<bundle-id>.widgets`, the same certificate, name exactly **Manhunt Crews Widgets App Store**.
4. Install them on this Mac (checks they match, then writes your team ID and both profile names into `ios/Config/Prod.local.xcconfig`, keeping your other values):
   ```bash
   scripts/ios-signing.sh install ~/Downloads/distribution.cer ~/Downloads/Manhunt_Crews_App_Store.mobileprovision ~/Downloads/Manhunt_Crews_Widgets_App_Store.mobileprovision
   ```
   The first time `codesign` uses the key, macOS asks for keychain access; choose **Always Allow**. If the script says the certificate isn't trusted, run the command it prints, which installs Apple's WWDR intermediate.
5. **Keys → +** → name "Manhunt Crews APNs" → enable **Apple Push Notifications service (APNs)**.
   - Download the `.p8`. You can download it only once.
   - Note its **Key ID** and your **Team ID**.
   - Never put the file in the repo.

## 2. App Store Connect (browser, appstoreconnect.apple.com)
1. **Apps → + → New App**:
   - Platform: iOS
   - Name: must be unique on the App Store, so "Manhunt Crews" may be taken
   - Bundle ID: `<bundle-id>`
   - SKU: any unique value
2. **Users and Access → Integrations → App Store Connect API → Team Keys → +**, role **App Manager**.
   - Download the key to `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`.
   - Note the **Key ID** and the **Issuer ID**.
   - Creating it needs the Account Holder or Admin role. This key lets the release script upload without signing in.
3. **App Privacy**: Privacy Policy URL `https://<prod-project-id>.web.app/privacy`. Data types to declare:
   - Precise Location, Photos, Name, Email Address, User ID, Other User Content
   - All of them linked to the user and used for app functionality
   - None used for tracking

## 3. Firebase console (console.firebase.google.com → your project)
1. **Upgrade to Blaze** (Usage and billing → Modify plan) and link a billing account. Set a budget.
2. **Project settings → Cloud Messaging → Apple app configuration** → upload the APNs `.p8` with its Key ID and Team ID. The same key carries the Live Activity pushes (ADR 0017); there's nothing else to configure.

## 4. Backend (terminal, after Blaze)
1. Choose a public contact email for the privacy and support pages. Put it in `hosting/contact-email.local` (git-ignored) or export `CONTACT_EMAIL`. The Hosting predeploy (`scripts/build-hosting.mjs`) fills it in, and the deploy refuses to publish without it.
2. One-time setup. It runs gcloud as `GCLOUD_ACCOUNT`, whichever account is active in gcloud:
   ```bash
   GCLOUD_ACCOUNT=<your Google account> PROJECT_ID=<prod-project-id> ENV_NAME=prod ALERT_EMAIL=<you> scripts/setup-gcp-project.sh
   ```
3. Deploy. Choose **prod** when asked for `APP_ENV`:
   ```bash
   PROJECT_ID=<prod-project-id> scripts/deploy-backend.sh
   ```
4. Check: `curl https://us-central1-<prod-project-id>.cloudfunctions.net/api/healthz` should return `{"ok":true,…}`, and `https://<prod-project-id>.web.app/privacy` should load.

## 5. Build and upload
```bash
ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> scripts/ios-release.sh
```
This archives the **Prod** configuration with build number = UTC time, signs it manually, and uploads it. It refuses to run while `Prod.local.xcconfig` still has the placeholder bundle ID or project. Without the `ASC_*` variables it only exports `ios/build-release/export/ManhuntCrews.ipa`, which you can upload with Apple's Transporter app. App Store Connect shows the build under TestFlight after processing. The app declares that it uses only exempt encryption (HTTPS and Apple's built-in encryption).

## 6. TestFlight
1. **Internal testing first.** Add yourself, install TestFlight on two iPhones, and play a full outdoor round against prod.
2. **External testing.** Create a group, add friends by email or turn on a public link, and fill in Test Information:
   - a description
   - a feedback email
   - for reviewers: a demo account, plus a note that a round needs two phones
3. The first build goes through Beta App Review. Builds expire after 90 days, so rerun step 5 to ship updates.
4. A new backend that changes the view or API shapes needs a new build shipped with it; older builds stop working against it.

## Later
- **Sign in with Apple:** enable the capability on the App ID, regenerate the profile, add `com.apple.developer.applesignin` to `ManhuntCrews-Prod.entitlements`, set `MH_ENABLE_APPLE_SIGN_IN = YES` in `Prod.xcconfig`, and enable the Apple provider in Firebase Auth.
- **Renewals:** the distribution certificate expires after a year. Repeat steps 1.2–1.4 with a new CSR (`scripts/ios-signing.sh csr` after moving the old key away).
