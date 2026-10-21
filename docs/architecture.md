# Architecture

```mermaid
flowchart TD
  H[Hiding crew phones — 1–5 each] -->|private GPS batches, Firebase ID token| API[Cloud Function api — public HTTPS]
  S[Seeking crew phones — 1 or 2 crews] -->|private GPS + photo claims| API
  API --> DB[(Firestore — authoritative state + raw points, server-only)]
  API --> GCS[(Private Cloud Storage bucket — photos, track archives)]
  API --> V[Firestore sessions/{sid}/views/{uid} — sanitized per-user read model]
  V -->|own view only (rules)| H
  V -->|own view only (rules)| S
  API --> Q[Task queue tick — one wake-up per round/generation/event]
  Q -->|OIDC, backend SA only| W[Cloud Function tick — private]
  SC[Scheduled functions watchdog 1/min, retention daily] --> DB
  SC --> Q
  W --> DB
  W --> V
  W --> Q
  API & W --> PUSH[FCM → APNs (supplementary)]
```

## Components

| Path | What it is |
|---|---|
| `backend/src/domain/` | Pure, I/O-free game core: `engine.ts` (round state machine), `clock.ts` (pause-aware time math), `tick.ts` (process due deadlines), `pingSelection.ts` (§5.3 eligibility), `geo.ts` (distance/coverage/simplification), `scoring.ts` (scorecards, crew-attributed analytics), `views.ts` (**the only producer of client-readable game state**). |
| `backend/src/services/` | Firestore transactions (`gameService.ts`), post-round finalization (`finalize.ts`), social graph (`socialService.ts`), deletion/retention/exports (`dataService.ts`), task-queue / local schedulers, Cloud Storage store with JPEG metadata stripping, FCM notifier. |
| `backend/src/api/` | Fastify public API: Firebase ID-token auth, per-uid rate limits, idempotency keys, typed errors, `serverTime` on every response. |
| `backend/src/functions/` | Cloud Functions for Firebase entry point (`firebase deploy`): `api` (HTTPS, public; replays requests into the Fastify app), `tick` (task queue, private, backend service account only), `watchdog` and `retention` (scheduled, private). ADR 0012. |
| `backend/src/worker/` | The tick payload schema, and a local-only HTTP twin of the deployed worker functions (`/internal/rounds/tick` + spec aliases, watchdog, retention) for `scripts/dev.sh` and tests; secret-gated, never deployed. |
| `firestore.rules` | Clients may `get` only `sessions/{sid}/views/{their uid}` while an active member. Everything else denied; no client writes. |
| `ios/ManhuntCrews/` | SwiftUI app. `Services/Location` (background GPS), `Services/OfflineQueue` (encrypted queue), `Services/Realtime` (own-view listener), `Services/Clock` (server clock), `Features/*` (screens). |
| `firebase.json` + `scripts/` | `firebase deploy` ships the functions, task queue, scheduler jobs, rules, indexes and TTL policies. `scripts/setup-gcp-project.sh` does the one-time rest: backend service account + least-privilege IAM, private media bucket, log metric, alerts, budget. |
| `shared/openapi.yaml` | API contract; a unit test asserts it matches the registered routes. |

## Data flows

**Crews and phones (ADR 0013).** A night has two or three crews; each crew has a roster of names and 1–5 equal operator phones. One crew hides per round and every other crew seeks (TOGETHER or RACE). When a round starts, each crew's consenting phones are frozen into `round.operatorsByTeam`; every in-round permission and post-round artifact is checked against that snapshot. Nights are open-ended (ADR 0014).

**Private telemetry.** Each operator phone records samples (≈5–15 s / 10 m moving, 30 s stationary) into an AES-GCM-encrypted on-disk queue and uploads batches every ~15 s (`POST …/location-batches`). The server stamps the phone's crew and role from the round snapshot, corrects device clock skew (`receivedAt − sentAt`), flags quality, and inserts points idempotently by `pointId` under `sessions/{sid}/rounds/{rid}/points` (server-only, 30-day TTL). Health goes to the member doc without a transaction unless the phone's coarse status changes (ADR 0016).

**Released game information.** At each deadline the worker runs `tickRound` inside a Firestore transaction: it queries hiding-crew candidates (`role == HIDING`) near the deadline, applies `selectPingSample` across the crew's phones (freshest fix; accuracy breaks 10 s ties; recorded *and received* ≤ deadline, ≤60 s old, ≤50 m, not during a pause, per-phone spike check), appends an immutable `PingRelease`, creates `pings/p{index}` with `tx.create` (duplicate-proof), and re-renders the views that changed in the same commit. With no qualifying sample the ping **waits** (ADR 0015): the next hiding-crew upload (or tick, or watchdog pass) releases the crew's *current* position, labelled late.

**Views.** `views.ts` renders each member's view from session + round + members + active claim. Its inputs contain no raw samples; the only coordinates it can emit are released pings, and never which phone a pin came from. Seeker views get the last *N* released pins; hiding-crew phones get the capture request; phones not in the round get neither. Crew health is coarse (live/total phones and a state). A view is written only when its content hash changes, and `GET /v1/sessions/{id}` serves the stored view with an ETag (ADR 0016).

## Server-authoritative timing

* `roundStartAt` = server time of the start call (any phone of a playing crew). All deadlines derive from persisted `roundStartAt`, `chaseStartAt` and `pauses[]` via `clock.ts`; pauses may overlap (safety pause during a pending claim) and are unioned.
* `chaseStartAt` is the *official* pause-adjusted deadline, not processing time; ping 0 is scheduled exactly there.
* Ping *n* is due when effective (pause-excluded) chase time reaches `n × interval`. A capture claim opens a `CAPTURE` pause at submission; rejection/expiry closes it, shifting every future deadline.
* Clients render clocks as `accumulatedMs + (serverNow − runningSince)`; `ServerClock` anchors server time to a monotonic clock that keeps counting through device sleep, so neither changing the phone's clock nor locking it mid-round can alter timers.

## Scheduling and idempotency

* After every state change the API/worker enqueues one task on the `tick` function's Cloud Tasks queue for the next event, with id `r-{roundId}-g{generation}-{event}` (Cloud Tasks dedups ids). `phaseGeneration` increments on every pause/resume/claim transition.
* The worker tick is idempotent: it processes whatever is due at `now`, in order, against the transactionally read state. Stale or duplicate tasks are harmless no-ops.
* The watchdog (scheduled function, 1/min) ticks every active round (repairing missed wake-ups, re-checking a waiting ping and refreshing coarse crew status), re-enqueues the next wake-up, counts overdue deadlines (alerted), and retries any unfinished post-round finalization (`summaryReady === false`).
* Late processing never changes *which* sample is eligible (selection is by deadline), and is labelled `delayed` with the measured dispatch latency.

## Post-round

`finalize.ts` computes, per crew, walking (total + chase) or driving (chase) distance, coverage and quality from the crew's best-covered phone, simplified polylines (Douglas–Peucker, 8 m, split at >120 s gaps), a gzip GeoJSON raw-track archive per phone in GCS, and the round summary. Routes are served only after the round ends, only to the round's phones, and only when every phone in the round consented to post-round route sharing. "Delete my data" removes one phone's tracks and the pins released from its fixes, then recomputes its crew's route from the crew's other phones.

## Local development

`scripts/dev.sh` = Firebase emulators (Auth 9099, Firestore 8085, Storage 9199) + API (8787) + worker (8788) + in-process scheduler + 10–15 s watchdog, project `demo-manhunt`. The iOS Debug configuration points at it (`MH_DEV_HOST`). It runs the same Fastify apps the functions wrap, with fast restarts.

`npm run serve:functions` runs the deployable code itself in the Functions + Cloud Tasks emulators (API at `http://127.0.0.1:5001/demo-manhunt/us-central1/api`); it uses the same emulator ports, so stop `dev.sh` first. The Cloud Tasks emulator ignores `scheduleTime` and the emulator doesn't run the scheduled watchdog, so deadlines there rely on `tick`'s early-arrival wait-and-retry (ADR 0012). It is fine for short test rules; use `dev.sh` for real nights.
