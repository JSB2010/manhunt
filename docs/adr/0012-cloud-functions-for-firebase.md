# ADR 0012 — Deploy on Cloud Functions for Firebase with one `firebase deploy`

**Status:** accepted · supersedes the Cloud Run + Terraform deployment in the v0.1 implementation · **Spec:** §5.4 (server-side deadlines), §9 (Google Cloud backend), §11 (least privilege, no keys)

**Context.**
- v0.1 deployed in four steps:
  1. A Terraform module created APIs, service accounts, the Cloud Tasks queue, the media bucket and alerts.
  2. A gcloud script built a container and deployed two Cloud Run services: a public API and an internal worker.
  3. A second `terraform apply` with the worker URL created the Cloud Scheduler jobs and the invoker IAM.
  4. `firebase deploy` shipped the rules.
- That was two tools and several steps for a friends-only app.
- The owner wants the backend to deploy with Firebase tooling alone.

**Decision.**
1. **Four functions** (2nd gen, `backend/src/functions/index.ts`):

   | Function | Trigger | Invoker | Replaces |
   |---|---|---|---|
   | `api` | HTTPS | public; Firebase ID token checked in-app | Cloud Run `manhunt-api` |
   | `tick` | Task queue | backend service account only | Cloud Run `manhunt-worker` + `round-deadlines` queue |
   | `watchdog` | Schedule `* * * * *` UTC | backend service account (set by the CLI) | Scheduler job → worker |
   | `retention` | Schedule `17 4 * * *` UTC | backend service account (set by the CLI) | Scheduler job → worker |

2. **The API stays a Fastify app.** The Functions Framework has already read the request body, so `functions/http.ts` replays each request into the app with `inject` (method, path, headers, `rawBody`). This is the same pipeline the integration tests drive, so content-type parsers, body limits, auth, rate limits, idempotency and error mapping are unchanged. Responses are buffered, which is fine for JSON and one ≤ 8 MB photo.
3. **Deadline wake-ups go through the Admin SDK task queue** (`getFunctions().taskQueue('locations/us-central1/functions/tick')`):
   - Deterministic task ids (`r-{round}-g{generation}-{event}`) keep Cloud Tasks deduplication.
   - `functions/task-already-exists` counts as success.
   - Retry and rate settings match the old queue: 20 attempts, 1–30 s backoff, 20 concurrent.
   - Correctness still never depends on delivery: the tick is idempotent and the watchdog repairs (ADR 0003).
   - A wake-up that arrives before its deadline would find nothing due and spend its task id. So `tick` waits out an early arrival of up to 30 s, and returns 503 for a longer one so that Cloud Tasks retries. In production Cloud Tasks never dispatches early, so this only covers clock skew.
4. **One least-privilege runtime identity, `manhunt-backend@`, for all four functions.**
   - Roles: `datastore.user`, `firebaseauth.admin`, `firebasecloudmessaging.admin`, log/metric writer, `objectAdmin` on the media bucket, and `serviceAccountUser` on itself.
   - It needs `serviceAccountUser` on itself to attach its own OIDC token to tasks.
   - `firebase deploy` grants it enqueuer on the `tick` queue and invoker on `tick` and the scheduled functions.
   - `tick` also re-checks that the token's email is this account (defense in depth after Cloud Run IAM).
5. **One-time setup.** What `firebase deploy` can't do lives in `scripts/setup-gcp-project.sh`, which is guarded and idempotent:
   - the service account and its roles
   - the private media bucket (uniform access, public access prevention, 400-day lifecycle backstop)
   - the overdue-deadline log metric
   - optional email alerts and a budget

   TTL policies were already in `firestore.indexes.json`.
6. **Runtime config.** `APP_ENV` is a Functions param. The first deploy asks for dev or prod and saves the answer in `backend/.env.<project>` (git-ignored). No secrets exist or are needed.
7. **Deploy-time discovery** imports the module with no runtime config, so nothing touches Firebase until a function runs. A security test asserts this, and the deployed surface above.
8. **Local development is unchanged.** `scripts/dev.sh` still runs the Fastify API and worker with an in-process scheduler. The worker app is now local-only: it has a shared secret, no OIDC, and is never deployed. `npm run serve:functions` runs the deployable entry points in the Functions and Cloud Tasks emulators.

**Consequences.**
- One command ships everything: `firebase deploy --only functions,firestore,auth,hosting`, wrapped with guardrails in `scripts/deploy-backend.sh`. There's no container image, Artifact Registry repo of our own, or Terraform state. `infra/terraform`, its CI workflow, the Dockerfile and the Cloud Run entry points were removed; they remain in git history.
- 2nd-gen functions are Cloud Run services, so runtime behavior, logs (`resource.type="cloud_run_revision"`) and limits (32 MB requests) are as before. The Cloud Run service names are now `api` and `tick`, and the alert filters were updated.
- The Blaze plan is still required. Firebase requires it for any server code.
- `@google-cloud/tasks` and `google-auth-library` were dropped; `firebase-functions` was added.
- The Cloud Tasks emulator ignores `scheduleTime` and delivers immediately, and the emulator doesn't run scheduled functions. Under `serve:functions`, deadlines therefore arrive through the early-arrival wait-and-retry path above. That works for short rules (gaps of up to about 8 minutes, within the 20-attempt retry budget). Real nights are played on `dev.sh`, whose scheduler is exact.
- The API is reached at the function's `run.app` URL. The adapter also strips a leading `/api`, so the `cloudfunctions.net/api` URL and Hosting rewrites work.
