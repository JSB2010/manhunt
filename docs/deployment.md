# Deployment & operations

Nothing has been deployed. Every step below needs a **dedicated** GCP/Firebase project and your explicit approval for billing.

## Environments
| Env | Project | Purpose |
|---|---|---|
| local | `demo-manhunt` (emulators) | development, automated tests, two-simulator E2E |
| dev | e.g. `manhunt-dev-<suffix>` | shared backend for physical-iPhone testing / TestFlight |
| prod | e.g. `manhunt-prod-<suffix>` | friends-only production (separate bundle id + Firebase config + APNs environment) |

Never write test GPS or seed accounts into dev/prod — the seed script refuses non-`demo-` projects.

## First deploy (dev)
1. Project + Firebase setup: `scripts/setup-firebase.md`.
2. `cd infra/terraform/environments/dev && cp terraform.tfvars.example terraform.tfvars && terraform init && terraform plan` → review → `terraform apply`. Creates: APIs, Firestore (+ TTL on `points.expireAt`, `idempotency.expireAt`), private media bucket (uniform access, public access prevention), Artifact Registry, service accounts (`manhunt-api`, `manhunt-worker`, `manhunt-tasks-invoker`, `manhunt-scheduler`) with least-privilege roles, `round-deadlines` Cloud Tasks queue, alert policies, optional budget.
3. `PROJECT_ID=manhunt-dev-<suffix> scripts/deploy-backend.sh` → builds the image with Cloud Build, deploys `manhunt-worker` (ingress internal, no public invoker) and `manhunt-api` (public, Firebase-token auth in-app), deploys Firestore rules/indexes and Storage rules.
4. Put the printed worker URL in `terraform.tfvars` (`worker_url`) and `terraform apply` again → worker `run.invoker` for the task/scheduler identities, Scheduler jobs (watchdog every minute, retention daily at 04:17 UTC).
5. iOS `Local.xcconfig`: `MH_USE_EMULATORS = NO`, API URL, `GoogleService-Info.plist`.

## Runtime configuration (env vars; no secrets required)
| Var | API | Worker | Notes |
|---|---|---|---|
| `APP_ENV` | dev/prod | dev/prod | prod refuses emulator hosts |
| `GOOGLE_CLOUD_PROJECT` | ✓ | ✓ | |
| `MEDIA_BUCKET` | ✓ | ✓ | `<project>-manhunt-media` |
| `TASKS_LOCATION`, `TASKS_QUEUE` | ✓ | ✓ | `round-deadlines` |
| `TASKS_INVOKER_SA` | ✓ | ✓ | OIDC identity on tasks |
| `WORKER_URL`, `WORKER_AUDIENCE` | ✓ | | task target |
| `WORKER_ALLOWED_INVOKERS` | | ✓ | comma-separated SA emails accepted by the worker |
| `INVITE_TTL_MINUTES`, `MAX_PHOTO_BYTES` | optional | | |

Firebase Admin uses the attached service account (ADC). APNs credentials live in Firebase (uploaded .p8), not in this backend. Secret Manager is provisioned (API enabled) for future integration secrets; none are needed today.

## Observability
* Structured JSON logs (`severity`, `service`, `reqId`), coordinates redacted by key, request bodies never logged.
* `watchdog pass` log line per minute: `activeRounds`, `ticked`, `overdue`, `rescheduled`, `finalized`, `errors` → log metric `manhunt_watchdog_overdue` → alert.
* Ping releases record `dispatchLatencyMs` and `delayed` in the round and audit events.
* API 5xx alert; budget alerts at 50/90/100 %.

## Data deletion runbook
* User-initiated: in-app "Delete my data" (per night), "Delete night" (organizer), "Delete account".
* Incident: `POST /v1/sessions/{id}/revoke` (organizer) or, as an admin, delete `sessions/{id}` recursively (`firebase firestore:delete --recursive sessions/<id>`) and `gsutil -m rm -r gs://<bucket>/sessions/<id>/`.

## Rollback
Cloud Run keeps revisions: `gcloud run services update-traffic manhunt-api --to-revisions <rev>=100`. Firestore schema changes are additive; views are re-rendered on the next state change.
