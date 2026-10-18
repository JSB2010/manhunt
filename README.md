# Manhunt Crews

A friends-only, two-crew Manhunt game: **one iPhone per crew**. The hiding crew's phone records a private GPS route; the seeking crew gets only **scheduled, server-released location pings** (first one exactly when the head start ends). Seekers claim a catch with an in-app photo that the hiding operator confirms. Crews swap roles each round (typically four per night), and nights build into crew-attributed history, friends, saved people and reusable groups.

> Working name only — not a cleared App Store name.

| | |
|---|---|
| iOS app | `ios/` — SwiftUI, MapKit, Core Location (background), AVFoundation camera, Firebase Auth/Firestore/Messaging. iOS 18+. |
| Backend | `backend/` — Node 24 + TypeScript + Fastify on Cloud Run (public API + private worker), Firestore, private GCS, Cloud Tasks, Cloud Scheduler, FCM. |
| Contract | `shared/openapi.yaml` (enforced by a contract test) |
| Infra | `infra/terraform/` (dedicated project), `firestore.rules`, `firestore.indexes.json`, `storage.rules` |
| Docs | `docs/` — architecture, threat model, scoring & privacy, Apple distribution, deployment, test matrix, ADRs, product spec |

## The invariant
While a round is active, the seeking operator can access **only released, scheduled hider pins** — never the hider's live route, latest sample or upcoming position. This is enforced in the server and in Firestore/Storage rules, not by hiding UI. The host gets no special visibility. See `docs/permissions-threat-model.md`.

## Quick start (local, no cloud account needed)

Requirements: Node 24+, Java 21+ (Firebase emulators), Firebase CLI, Xcode 16+ (tested with Xcode 27 / iOS 27 simulators).

```bash
cd backend && npm ci && cd ..
scripts/dev.sh                     # emulators + API :8787 + worker :8788 (project demo-manhunt)
```

In another terminal:

```bash
cd backend && npm run seed:emulator   # emulator-only demo accounts (backend/scripts/seed-accounts.json)
```

Open `ios/ManhuntCrews.xcodeproj`, pick a simulator, Run. Sign in with a seeded account (or create one). For two phones use two simulators — or run the automated two-simulator round:

```bash
scripts/e2e-two-simulators.sh "iPhone 17" "iPhone 18 Pro"
```

Physical iPhones: see `docs/apple-distribution.md` (free Personal Team works for development; Push and Sign in with Apple need the paid program).

## Tests

```bash
cd backend
npm run typecheck
npm run test:unit                  # domain, privacy invariant, OpenAPI contract
npm run test:integration           # Auth/Firestore/Storage emulators: full 4-round night + hard negative security tests + rules
xcodebuild test -project ios/ManhuntCrews.xcodeproj -scheme ManhuntCrews -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:ManhuntCrewsTests
```

Results and the physical-device acceptance checklist: `docs/test-matrix.md`.

## Deploying (requires your approval and a dedicated GCP project)
Nothing in this repo deploys automatically. `docs/deployment.md` walks through Terraform (`infra/terraform/environments/dev`), `scripts/deploy-backend.sh` (refuses non-Manhunt project ids and asks for confirmation) and Firebase rules/indexes.

## Repository map
```
backend/src/domain      pure game core (state machine, clock, ping selection, geo, scoring, views)
backend/src/services    Firestore transactions, finalization, social, deletion/retention, schedulers, storage, push
backend/src/api         public Fastify API      backend/src/worker  private worker
backend/tests           unit / integration / security (emulators)
ios/ManhuntCrews        App, Features/*, Services/{API,Auth,Location,OfflineQueue,Realtime,Clock,Notifications}, Models
ios/ManhuntCrewsTests   unit tests          ios/ManhuntCrewsUITests  two-simulator E2E
scripts/                dev.sh, emulator-start.sh, e2e-two-simulators.sh, deploy-backend.sh, setup-firebase.md
```
