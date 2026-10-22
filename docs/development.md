# Developer guide

How to set up, run, test and change Manhunt Crews. For how the pieces fit together, read [architecture.md](architecture.md) first. For the rules every change must keep, read [AGENTS.md](../AGENTS.md).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| macOS + Xcode | **Xcode 27** (iOS 27 SDK) | The app uses iOS 27 APIs behind availability checks. The deployment target is iOS 18 |
| iOS simulator runtimes | iOS 27, plus **iOS 18.5** | The two-simulator E2E runs on 18.5, because the iOS 27 runtime stalls with two concurrent UI-test sessions |
| Node.js | **24** | `firebase.json` deploys the `nodejs24` runtime. `package.json` allows ≥ 22 |
| Java | **21** | For the Firebase emulators. JDK 24+ crashes the Storage emulator on the first upload. `scripts/emulator-start.sh` picks JDK 21 when it's installed |
| Firebase CLI | 15.x | `npm i -g firebase-tools`. Verified with 15.28 |
| gcloud | recent | Only for deploying ([deployment.md](deployment.md)) |

You don't need a cloud account for anything on this page. Local work uses the Firebase Emulator Suite with the project id `demo-manhunt`, and the backend refuses to run locally against any project that isn't `demo-*`.

## First-time setup

```bash
git clone <repo> manhunt && cd manhunt
cd backend && npm ci && cd ..
```

For iOS, open `ios/ManhuntCrews.xcodeproj`. Swift packages (Firebase 12.x) resolve on first open. Nothing else is needed for the simulator.

## Run the local stack

```bash
scripts/dev.sh
```

This starts:

| What | Port | Notes |
|---|---|---|
| Auth emulator | 9099 | |
| Firestore emulator | 8085 | |
| Storage emulator | 9199 | |
| Emulator UI | 4000 | http://127.0.0.1:4000, to inspect documents |
| Emulator hub / logging | 4400 / 4500 | |
| **API** (`backend/src/api`) | **8787** | Listens on all interfaces, so a phone on your Wi-Fi can reach it |
| Local worker (`backend/src/worker`) | 8788 | 127.0.0.1 only, gated by a shared secret, never deployed |

The worker gets deadline wake-ups from an in-process scheduler, a stand-in for Cloud Tasks with exact timing. A watchdog runs every 15 s (`LOCAL_WATCHDOG_MS`) and the retention sweep hourly. Emulator data is kept in `./emulator-data` (git-ignored) between runs. Delete that folder for a clean slate.

Then seed the demo accounts, which are friends with each other:

```bash
cd backend && npm run seed:emulator
```

The accounts are listed in `backend/scripts/seed-accounts.json`. The seed script refuses to run anywhere but the Auth emulator of a `demo-*` project.

Useful variables for `backend/src/dev.ts`: `API_PORT`, `WORKER_PORT`, `API_HOST` (default `0.0.0.0`), `LOCAL_WATCHDOG_MS`, `MEDIA_BUCKET`, `DEV_WORKER_SECRET`.

### Run the deployable functions locally

```bash
scripts/dev.sh   # stop it first: the same emulator ports are used
cd backend && npm run serve:functions
```

This builds and runs `backend/src/functions/index.ts` in the Functions and Cloud Tasks emulators (functions on :5001, tasks on :9499). The API is at `http://127.0.0.1:5001/demo-manhunt/us-central1/api`. The Cloud Tasks emulator ignores `scheduleTime` and the scheduled watchdog doesn't run, so deadlines arrive through `tick`'s early-arrival wait-and-retry (ADR 0012). That's fine for short test rules. Use `dev.sh` for anything longer.

## Run the iOS app

1. Start `scripts/dev.sh` and seed the accounts.
2. Open `ios/ManhuntCrews.xcodeproj`, choose the **ManhuntCrews** scheme and an iPhone simulator, and Run.
3. Sign in with a seeded account, or create one.

To play both sides, run a second simulator: Xcode → Run on another destination. Or use the scripted two-phone round below.

### Targets and schemes

| Target | What it is |
|---|---|
| `ManhuntCrews` | The app |
| `ManhuntCrewsWidgets` | The Live Activity extension (`<bundle id>.widgets`) |
| `ManhuntCrewsTests` | Unit tests, plus a listener test that runs only against a live local stack |
| `ManhuntCrewsUITests` | The two-simulator E2E (`TwoPhoneE2ETests`) |

`ios/LiveActivityShared/` is compiled into both the app and the extension. The project uses file-system-synchronized groups, so a new Swift file in a target's folder is picked up without editing `project.pbxproj` (ADR 0009).

Schemes: **ManhuntCrews** (Debug and Release) and **ManhuntCrews Prod** (the Prod configuration, manual signing, see [release-prod.md](release-prod.md)).

### Build configuration

Settings flow from `ios/Config/*.xcconfig` into `Info.plist` (`MH…` keys) and are read by `App/AppEnvironment.swift`.

| File | Used by | Notes |
|---|---|---|
| `Shared.xcconfig` | every configuration | Defaults: bundle id `com.manhuntcrews.dev`, `demo-manhunt`, push and Sign in with Apple off |
| `Debug.xcconfig` | Debug | Emulators on, API `http://$(MH_DEV_HOST):8787` |
| `Release.xcconfig` | Release | Emulators off. Needs a real `MH_API_BASE_URL` and `GoogleService-Info.plist` |
| `Prod.xcconfig` | Prod | TestFlight builds. Your values go in `Prod.local.xcconfig` |
| `Local.xcconfig` | Debug, Release | **Git-ignored.** Your team id, bundle id, LAN host. Start from `Local.xcconfig.example` |
| `Prod.local.xcconfig` | Prod | **Git-ignored.** Start from `Prod.local.xcconfig.example`. `scripts/ios-signing.sh` writes to it |

| Setting | Meaning |
|---|---|
| `MH_DEV_HOST` | Debug only: host running `dev.sh`. `127.0.0.1` for simulators, your Mac's LAN IP for a phone. It's compiled in, so rebuild after changing it |
| `MH_USE_EMULATORS` / `MH_API_BASE_URL` | Emulators and the local API, or a deployed backend |
| `MH_FIREBASE_PROJECT_ID`, `MH_FIREBASE_PLIST` | The Firebase project, and which git-ignored `GoogleService-Info*.plist` to bundle |
| `MH_ENABLE_PUSH`, `MH_ENABLE_APPLE_SIGN_IN`, `MH_ENTITLEMENTS` | Paid-program features. Off by default, for Personal Team builds |
| `MH_SITE_URL` | The privacy and support pages linked from Settings |

Physical iPhones, Personal Team limits and the LAN setup: [apple-distribution.md](apple-distribution.md).

### Design QA fixtures

`backend/scripts/ui-fixture.ts` puts the demo accounts into one game state, so each screen can be reviewed in the simulator. The simulator signs in as Morgan, and the script drives Taylor through the real API.

```bash
cd backend && npx tsx scripts/ui-fixture.ts <lobby|headstart|chase|pending|paused|recap|night> [seek|hide] [two|three]
```

`seek` (the default) makes Morgan's crew seek, and `hide` makes it hide. `two` adds a second phone to Morgan's crew, and `three` adds a third crew (two seeking crews in Race mode).

## Tests

| Suite | Command | Needs | Covers |
|---|---|---|---|
| Typecheck | `cd backend && npm run typecheck` | — | All backend TypeScript, including tests and scripts |
| Backend unit | `npm run test:unit` | — | Domain (engine, clock, ping selection, geo, scoring), **view privacy invariant**, OpenAPI contract, schemas, Cloud Functions adapter and tick handler, Firestore index constraints, Live Activity contract and payloads |
| Backend integration + security | `npm run test:integration` | Java 21 | Starts Auth, Firestore and Storage emulators and runs `tests/integration` and `tests/security`: full nights, hard-negative privacy tests, Firestore rules, the deployed functions surface |
| Rules only | `npm run test:rules` | Java 21 | `tests/security/firestore-rules.test.ts` |
| Both backend suites | `npm test` | Java 21 | |
| Real-time E2E, 2 phones | `npm run e2e:two-operators` | `dev.sh` + seed | Wall-clock round through the real scheduler and worker: ping latency, no leaked coordinates |
| Real-time E2E, crews | `npm run e2e:crews` | `dev.sh` + seed | 5 phones, 3 crews, Race mode, waiting ping through a hider outage. Reports bandwidth per phone |
| iOS unit | `xcodebuild test -project ios/ManhuntCrews.xcodeproj -scheme ManhuntCrews -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:ManhuntCrewsTests` | Xcode 27 | Clock, cadence filter, encrypted queue, view decoding, auth resilience, networking, Live Activity mapping against the shared fixture |
| iOS listener | the same, with `dev.sh` running and `MH_DEV_HOST=127.0.0.1` | local stack | `ListenerIntegrationTests`. It's skipped otherwise |
| Two-simulator E2E | `scripts/e2e-two-simulators.sh "iPhone 16 Pro Max" "iPhone 16e"` | `dev.sh` + seed, two iOS 18.5 simulators | The real app on two simulators: night, join, ready, head start, pings with the hider backgrounded, photo catch, round 2 role swap (≈5 min). Artifacts in `test-artifacts/` |

Latest results, the spec coverage map and the physical-device checklist are in [test-matrix.md](test-matrix.md). Update it when you change what's covered.

Notes:
- `firebase.json`'s functions predeploy runs typecheck, unit tests and the build, so a red unit suite blocks a deploy.
- Run the E2E scripts against a fresh stack, or run `cd backend && npx tsx scripts/e2e-cleanup.ts` first. The two-simulator script does this itself.
- `test-artifacts/` is git-ignored because it can contain coordinates and screenshots. Keep it that way.

### CI

Both workflows run on pushes to `main`, on pull requests and on manual dispatch. A newer push to a PR cancels the older run.

- `.github/workflows/backend.yml` runs typecheck, build, unit tests and `npm run test:integration` on Node 24 and Java 21 for changes under `backend/`, the Firebase config or `shared/`. The Firebase CLI is pinned in `FIREBASE_TOOLS_VERSION` and cached with its emulator jars.
- `.github/workflows/ios.yml` runs the iOS unit tests (Debug, simulator) and an unsigned Release device build as two parallel jobs, for changes under `ios/` or `shared/`. They run on GitHub's `xcode-27` image with `DEVELOPER_DIR` pinned to Xcode 27.1. Swift packages are cached by `Package.resolved`, and Xcode's compilation cache is restored on every run but saved only from `main`.
- Bump the Xcode and Firebase CLI pins on purpose when local tooling moves. If the pinned Xcode leaves the image, the iOS job fails at its first step and lists the Xcodes that are installed.

## Making common changes

Each recipe lists every place that must change together. The tests named will fail if you miss one.

### Add or change an API endpoint
1. Request body: a **strict** zod schema in `backend/src/schemas/api.ts`. Unknown keys must fail.
2. Route: `backend/src/api/routes/<area>.ts`. Choose a rate bucket (`config: { rateLimit: … }`) if it shouldn't count as `default`.
3. Logic: a method on the right service in `backend/src/services/`. State changes run in a Firestore transaction.
4. Contract: add the path to `shared/openapi.yaml`. `tests/unit/openapi.contract.test.ts` fails on undocumented or stale routes.
5. iOS: `ios/ManhuntCrews/Services/API/Endpoints.swift` and the matching types in `Models/`.
6. Tests: an integration test, plus a case in `tests/security/authorization.test.ts` for who may *not* call it.

### Add data a phone can see
All client-readable game state is rendered by `backend/src/domain/views.ts`. Nothing else may produce it.
1. Add the field to the view types in `domain/types.ts` and render it in `views.ts`.
2. Add a case to `tests/unit/views.privacy.test.ts` that proves it can't carry hider coordinates or unreleased data to seekers, in every active phase.
3. Decode it in `ios/ManhuntCrews/Models/GameModels.swift`.
4. The view's content hash decides whether a phone gets a new snapshot (ADR 0016). A field that changes on every write, such as a timestamp, defeats that. Don't add one.

### Change the Live Activity
1. Server content: `liveActivityState` / `liveActivityAttributes` in `views.ts`.
2. Shared types: `ios/LiveActivityShared/RoundActivityAttributes.swift`. App mapping: `ios/ManhuntCrews/Services/LiveActivity/RoundActivityContent.swift`. UI: `ios/ManhuntCrewsWidgets/RoundLiveActivity.swift`.
3. Regenerate the contract fixture: `cd backend && UPDATE_FIXTURES=1 npx vitest run tests/unit/liveActivity.contract.test.ts`, then run the iOS `LiveActivityTests`. Both sides must produce the same content.
4. Never add coordinates, phone ids, names or free text. The Lock Screen is readable by anyone nearby.

### Add a rule or a deadline
- **Rule:** `RulesSchema` and `DEFAULT_RULES` in `backend/src/domain/rules.ts`. Decide whether it belongs in `rulesFingerprint`: anything that changes how comparable two chase times are does. Then `shared/openapi.yaml`, the iOS rules editor (`Features/SessionSetup/RulesEditor.swift`) and the models.
- **Deadline kind:** derive it from persisted round state in `engine.ts` (`nextScheduledEvent` / `nextDueEvent`) and handle it in `tick.ts`. Never store "fire at" times that can't be recomputed. Add engine tests for pauses moving it.

### Add a Firestore query
Add its index to `firestore.indexes.json`. Production allows **one** `array-contains` per query, which the emulator doesn't enforce. `tests/unit/firestore.indexes.test.ts` catches the pattern. Clients never query Firestore: `firestore.rules` allows only a `get` of your own view.

### Add a Cloud Function or a scheduled job
`backend/src/functions/index.ts` is the whole deployed surface. Only `api` may be public. Update `tests/security/functions-surface.test.ts`, and nothing may touch Firebase or read config at import time, because deploy discovery imports the module with no config. A new kind of function deserves an ADR.

### Record a decision
If an implementation detail departs from [product-spec.md](product-spec.md) or an existing ADR, add an ADR in `docs/adr/` ([format](adr/README.md)) and update the documents it changes.

## Code conventions

**Backend** (`backend/src`, ESM TypeScript, strict):
- `domain/` is pure: no I/O, no `Date.now()`. Time comes in as an argument. Services pass `deps.clock.now()`.
- Authoritative documents store times as epoch milliseconds. API and view payloads use ISO-8601 UTC strings. Live Activity payloads use epoch seconds.
- Fail with `AppError` codes from `domain/errors.ts`. The HTTP status comes from the code.
- Imports use `.js` suffixes (NodeNext). Logging goes through pino. Coordinate keys are redacted, and request bodies are never logged.
- Comments explain *why*, briefly, and cite the spec section or ADR where relevant.

**iOS** (`ios/ManhuntCrews`, Swift 5 language mode, SwiftUI):
- `AppModel` owns the app state. Services are in `Services/` and screens in `Features/<area>/`.
- Use the shared components in `Shared/DesignSystem.swift` and the colour tokens in the asset catalog. Colour means crew, never role. See [design-system.md](design-system.md).
- Keep accessibility identifiers stable: the UI tests depend on them.
- DEBUG-only test hooks (the simulator test photo, `-uiTestShortRules`) must stay out of Release builds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Storage emulator / Firebase CLI crashes on the first photo upload | You're on JDK 24+. Install JDK 21. `emulator-start.sh` uses it automatically, and for `npm run test:integration` export `JAVA_HOME` to it |
| `Local/test runs must use a demo- project id or the Firebase emulators` | The emulator variables aren't set. Use `scripts/dev.sh` or the npm scripts |
| `Port … is not open` / address in use | Another `dev.sh` or `serve:functions` is running. They share ports |
| App says it can't reach the game server | `dev.sh` isn't running, or `MH_DEV_HOST` is wrong for this device. Rebuild after changing it |
| Phone on Wi-Fi can't connect | Allow incoming connections for `java` and `node` in the macOS firewall prompt. Check `http://<Mac IP>:8787/healthz` from the phone, and allow Local Network access on the phone |
| Two-simulator E2E stalls or "failed to acquire background assertion" | Use iOS 18.5 simulators, not iOS 27 |
| Personal Team build stops launching | Personal Team profiles expire after 7 days. Rebuild and reinstall |
| Stale nights or accounts after many runs | Stop `dev.sh`, delete `emulator-data/`, start again and re-seed |
