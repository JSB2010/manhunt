# Deployment & operations

Nothing has been deployed. Every step below needs a **dedicated** Firebase project and your explicit approval for billing (Blaze plan). The backend runs on Cloud Functions for Firebase and ships with one `firebase deploy` ([ADR 0012](adr/0012-cloud-functions-for-firebase.md)).

## What runs where

| Piece | Firebase / Google product | Deployed by |
|---|---|---|
| `api` function: public HTTPS API (Fastify) | Cloud Functions (2nd gen, on Cloud Run) | `firebase deploy` |
| `tick` function: deadline wake-ups (chase start, pings, claim expiry, time cap) | Cloud Functions task queue (Cloud Tasks) | `firebase deploy` |
| `watchdog` (every minute), `retention` (daily 04:17 UTC) | Scheduled functions (Cloud Scheduler) | `firebase deploy` |
| Game state, views, raw points (TTL) | Cloud Firestore | `firebase deploy` (rules, indexes, TTL) |
| Sign-in | Firebase Authentication | console (enable Email/Password) |
| Push | Firebase Cloud Messaging → APNs | console (upload `.p8`, paid Apple program) |
| Photos, track archives | Private Cloud Storage bucket `<project>-manhunt-media` | `scripts/setup-gcp-project.sh` (once) |
| Runtime identity `manhunt-backend@`, IAM | IAM | `scripts/setup-gcp-project.sh` (once) |
| Overdue-deadline metric, alerts, budget | Cloud Logging / Monitoring / Billing | `scripts/setup-gcp-project.sh` (once, optional parts) |

## Environments
| Env | Project | Purpose |
|---|---|---|
| local | `demo-manhunt` (emulators) | development, automated tests, two-simulator E2E |
| dev | e.g. `manhunt-dev-<suffix>` | shared backend for physical-iPhone testing / TestFlight |
| prod | e.g. `manhunt-prod-<suffix>` | friends-only production (separate bundle id + Firebase config + APNs environment) |

Never write test GPS or seed accounts into dev/prod — the seed script refuses non-`demo-` projects.

## First deploy (dev)
1. **Project + Firebase setup** (console): `scripts/setup-firebase.md`. Upgrade to Blaze only when you approve the cost.
2. **One-time project setup** (APIs, service account, IAM, media bucket, log metric; alerts and budget if you pass `ALERT_EMAIL` / `BILLING_ACCOUNT`):
   ```bash
   gcloud auth login
   PROJECT_ID=manhunt-dev-<suffix> ALERT_EMAIL=you@example.com scripts/setup-gcp-project.sh
   ```
3. **Deploy** (functions, task queue, scheduler jobs, Firestore rules + indexes + TTL, Storage rules). The first run asks for `APP_ENV`; choose `dev`.
   ```bash
   firebase login
   PROJECT_ID=manhunt-dev-<suffix> scripts/deploy-backend.sh
   ```
   The script asks you to type the project id, then runs `firebase deploy --project <id> --only functions,firestore,storage`. `firebase.json`'s predeploy runs typecheck, unit tests and the build first.
4. **iOS** `Local.xcconfig`: `MH_USE_EMULATORS = NO`, `MH_API_BASE_URL = https:/$()/<api function URL>` (printed by the deploy, `https://api-…-uc.a.run.app`), plus the project's `GoogleService-Info.plist`.

Later deploys are step 3 only. `firebase deploy --only functions:api` (or `:tick`, …) ships one function.

## Runtime configuration (no secrets required)
| Var | Source | Notes |
|---|---|---|
| `APP_ENV` | Functions param, saved in `backend/.env.<project>` (git-ignored) | `dev` / `prod`; prod refuses emulator hosts |
| `GCLOUD_PROJECT`, `FIREBASE_CONFIG` | set by Cloud Functions | project id |
| `MEDIA_BUCKET` | optional override | default `<project>-manhunt-media` |
| `INVITE_TTL_MINUTES`, `MAX_PHOTO_BYTES` | optional, in `backend/.env.<project>` | |

Region (`us-central1`) and the runtime service account are set in `backend/src/functions/index.ts`; keep the region near the Firestore location and pass the same `REGION` to the setup script. Firebase Admin uses the function's service account (ADC). APNs credentials live in Firebase (uploaded .p8), not in this backend.

## Security of the deployed surface
* `api` is the only public function; every route except `/healthz` and `/v1/time` verifies a Firebase ID token in-app.
* `tick` accepts tasks only from `manhunt-backend@` (Cloud Run IAM + an in-handler email check). `watchdog` and `retention` are invoked only by their scheduler jobs as that account.
* `tests/security/functions-surface.test.ts` asserts the exported functions, invokers and service account.

## Observability
* Structured JSON logs (`severity`, `service`, `reqId`), coordinates redacted by key, request bodies never logged. Functions log as `resource.type="cloud_run_revision"` with `service_name` = function name.
* `watchdog pass` log line per minute: `activeRounds`, `ticked`, `overdue`, `rescheduled`, `finalized`, `errors` → log metric `manhunt_watchdog_overdue` → alert.
* Ping releases record `dispatchLatencyMs` and `delayed` in the round and audit events.
* API 5xx alert (`service_name="api"`); budget alerts at 50/90/100 %.

## Data deletion runbook
* User-initiated: in-app "Delete my data" (per night), "Delete night" (organizer), "Delete account".
* Incident: `POST /v1/sessions/{id}/revoke` (organizer) or, as an admin, delete `sessions/{id}` recursively (`firebase firestore:delete --recursive sessions/<id>`) and `gcloud storage rm -r gs://<bucket>/sessions/<id>/`.

## Rollback
Each function is a Cloud Run service that keeps revisions: `gcloud run services update-traffic api --region us-central1 --to-revisions <rev>=100` (same for `tick`). Or check out the previous commit and redeploy. Firestore schema changes are additive; views are re-rendered on the next state change.
