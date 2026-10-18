# Architecture

```mermaid
flowchart TD
  H[Hider iPhone — operator] -->|private GPS batches, Firebase ID token| API[Cloud Run — public API manhunt-api]
  S[Seeker iPhone — operator] -->|private GPS + photo claims| API
  API --> DB[(Firestore — authoritative state + raw points, server-only)]
  API --> GCS[(Private GCS bucket — photos, track archives)]
  API --> V[Firestore sessions/{sid}/views/{uid} — sanitized per-user read model]
  V -->|own view only (rules)| H
  V -->|own view only (rules)| S
  API --> Q[Cloud Tasks — one wake-up per round/generation/event]
  Q -->|OIDC| W[Cloud Run — private worker manhunt-worker]
  SC[Cloud Scheduler — watchdog 1/min, retention daily] -->|OIDC| W
  W --> DB
  W --> V
  W --> Q
  API & W --> PUSH[FCM → APNs (supplementary)]
```

## Components

| Path | What it is |
|---|---|
| `backend/src/domain/` | Pure, I/O-free game core: `engine.ts` (round state machine), `clock.ts` (pause-aware time math), `tick.ts` (process due deadlines), `pingSelection.ts` (§5.3 eligibility), `geo.ts` (distance/coverage/simplification), `scoring.ts` (scorecards, crew-attributed analytics), `views.ts` (**the only producer of client-readable game state**). |
| `backend/src/services/` | Firestore transactions (`gameService.ts`), post-round finalization (`finalize.ts`), social graph (`socialService.ts`), deletion/retention/exports (`dataService.ts`), Cloud Tasks / local schedulers, GCS store with JPEG metadata stripping, FCM notifier. |
| `backend/src/api/` | Fastify public API: Firebase ID-token auth, per-uid rate limits, idempotency keys, typed errors, `serverTime` on every response. |
| `backend/src/worker/` | Private worker: OIDC-verified invoker allow-list, `/internal/rounds/tick` (+ spec aliases), watchdog, retention sweep. |
| `firestore.rules` | Clients may `get` only `sessions/{sid}/views/{their uid}` while an active member. Everything else denied; no client writes. |
| `ios/ManhuntCrews/` | SwiftUI app. `Services/Location` (background GPS), `Services/OfflineQueue` (encrypted queue), `Services/Realtime` (own-view listener), `Services/Clock` (server clock), `Features/*` (screens). |
| `infra/terraform/` | Dedicated-project IaC: APIs, Firestore + TTL, private bucket, service accounts + least-privilege IAM, Cloud Tasks queue, Scheduler jobs, alerts, budget. |
| `shared/openapi.yaml` | API contract; a unit test asserts it matches the registered routes. |

## Data flows

**Private telemetry.** Each operator phone records samples (≈5–15 s / 10 m moving, 30 s stationary) into an AES-GCM-encrypted on-disk queue and uploads batches every ~15 s (`POST …/location-batches`). The server derives the operator's role from the round snapshot, corrects device clock skew (`receivedAt − sentAt`), flags quality, and inserts points idempotently by `pointId` under `sessions/{sid}/rounds/{rid}/points` (server-only, 30-day TTL).

**Released game information.** At each deadline the worker runs `tickRound` inside a Firestore transaction: it queries hider candidates near the deadline, applies `selectPingSample` (recorded *and received* ≤ deadline, ≤60 s old, ≤50 m, not during a pause, not a spike), appends an immutable `PingRelease`, creates `pings/p{index}` with `tx.create` (duplicate-proof), and re-renders both members' views in the same commit. A ping without a qualifying sample is released as `NO_FRESH_FIX` with no coordinates.

**Views.** `views.ts` renders each member's view from session + round + members + active claim. Its inputs contain no raw samples; the only coordinates it can emit are released pings. Seeker views get the last *N* released pins; hider views get the capture request. Opponent health is coarse (state + 30 s-bucketed heartbeat).

## Server-authoritative timing

* `roundStartAt` = server time of the host's start call. All deadlines derive from persisted `roundStartAt`, `chaseStartAt` and `pauses[]` via `clock.ts`; pauses may overlap (safety pause during a pending claim) and are unioned.
* `chaseStartAt` is the *official* pause-adjusted deadline, not processing time; ping 0 is scheduled exactly there.
* Ping *n* is due when effective (pause-excluded) chase time reaches `n × interval`. A capture claim opens a `CAPTURE` pause at submission; rejection/expiry closes it, shifting every future deadline.
* Clients render clocks as `accumulatedMs + (serverNow − runningSince)`; `ServerClock` anchors server time to monotonic uptime so changing the phone's clock cannot alter timers.

## Scheduling and idempotency

* After every state change the API/worker enqueues one Cloud Task for the next event, named `r-{roundId}-g{generation}-{event}` (Cloud Tasks dedups names). `phaseGeneration` increments on every pause/resume/claim transition.
* The worker tick is idempotent: it processes whatever is due at `now`, in order, against the transactionally read state. Stale or duplicate tasks are harmless no-ops.
* The watchdog (Cloud Scheduler, 1/min) ticks every active round, re-enqueues the next wake-up, counts overdue deadlines (alerted), and retries any unfinished post-round finalization (`summaryReady === false`).
* Late processing never changes *which* sample is eligible (selection is by deadline), and is labelled `delayed` with the measured dispatch latency.

## Post-round

`finalize.ts` computes walking (total + chase) and driving (chase) distances, coverage and quality, simplified per-crew polylines (Douglas–Peucker, 8 m, split at >120 s gaps), a gzip GeoJSON raw-track archive in GCS, and the round summary. Routes are served only after the round ends and only when both operators consented to post-round route sharing.

## Local development

`scripts/dev.sh` = Firebase emulators (Auth 9099, Firestore 8085, Storage 9199) + API (8787) + worker (8788) + in-process scheduler + 10–15 s watchdog, project `demo-manhunt`. The iOS Debug configuration points at it (`MH_DEV_HOST`).
