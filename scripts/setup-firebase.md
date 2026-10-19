# Firebase project setup (when you are ready to leave the emulators)

All local development uses the Firebase Emulator Suite with project id `demo-manhunt` (no account, no billing). Only do this when you want a shared dev backend or TestFlight builds.

1. **Create a dedicated project** (don't reuse another app's project), e.g. `manhunt-dev-<suffix>`, in the Firebase console. This also creates the Google Cloud project.
2. **Upgrade to Blaze** (pay-as-you-go) only when you approve the cost. Cloud Functions need it. Usage for a friends-only game is small; the setup script can add a budget alert.
3. **Authentication** → Sign-in method → enable **Email/Password** (development provider). Enable **Apple** later (needs the paid Apple program).
4. **Firestore** → create the database in Native mode, in or near `us-central1` (the functions region).
5. **Register the iOS app** with your `MH_BUNDLE_ID`; download `GoogleService-Info.plist` to `ios/ManhuntCrews/` (git-ignored).
6. **Cloud Messaging** (paid Apple program): upload your APNs Auth Key (.p8).
7. **One-time setup**: `PROJECT_ID=<id> scripts/setup-gcp-project.sh`. It creates the backend service account and IAM, the private media bucket and the log metric. Add `ALERT_EMAIL=…` for alerts, and `BILLING_ACCOUNT=… BUDGET_USD=25` for a budget.
8. **Deploy**: `PROJECT_ID=<id> scripts/deploy-backend.sh`. One `firebase deploy` ships the functions (`api`, `tick`, `watchdog`, `retention`), the task queue, the scheduler jobs, Firestore rules, indexes and TTL, and Storage rules. Choose `dev` when it asks for `APP_ENV`.
9. **iOS**: in `ios/Config/Local.xcconfig` set `MH_USE_EMULATORS = NO`, `MH_FIREBASE_PROJECT_ID = <id>`, `MH_API_BASE_URL = https:/$()/<api function URL>`.

Never download service-account JSON keys; the functions run as the attached `manhunt-backend@` service account.
