# API

The public REST API is the `api` Cloud Function: a Fastify app in `backend/src/api`. The authoritative contract is **[`shared/openapi.yaml`](../shared/openapi.yaml)**. `tests/unit/openapi.contract.test.ts` fails if a registered route is missing from it or a documented one no longer exists. Request bodies are validated by the strict zod schemas in `backend/src/schemas/api.ts`, which reject unknown keys. The iOS client mirrors them in `ios/ManhuntCrews/Services/API/Endpoints.swift`.

## Base URLs

| Environment | Base URL |
|---|---|
| `scripts/dev.sh` | `http://127.0.0.1:8787` |
| `npm run serve:functions` | `http://127.0.0.1:5001/demo-manhunt/us-central1/api` |
| Deployed | `https://us-central1-<project>.cloudfunctions.net/api` or the function's `https://api-…run.app` URL. The adapter strips a leading `/api` |

## Conventions

- **Auth:** every route except `GET /healthz` and `GET /v1/time` needs `Authorization: Bearer <Firebase ID token>`. The caller's uid comes only from the token. Crew, role and permissions come from server-side membership and the round snapshot, never from the request body.
- **Server time:** every JSON object response carries `serverTime`, and every response has an `X-Server-Time` header. Clients render clocks from it, never from the device clock.
- **Errors:** `{ "error": { "code", "message", "details" }, "requestId", "serverTime" }`. The codes are in `backend/src/domain/errors.ts`:

  | Status | Codes |
  |---|---|
  | 400 | `VALIDATION_FAILED` |
  | 401 | `UNAUTHENTICATED` |
  | 403 | `OPERATOR_NOT_AUTHORIZED`, `FORBIDDEN` |
  | 404 | `NOT_FOUND` (also for things you may not know exist) |
  | 409 | `STALE_PHASE`, `GAME_NOT_READY`, `ALREADY_CLAIMED`, `GAME_CLOSED`, `CONFLICT` |
  | 410 | `CAPTURE_EXPIRED`, `INVITE_INVALID` |
  | 412 | `GPS_UNAVAILABLE`, `PERMISSION_REQUIRED`, `LOCATION_STALE`, `CONSENT_REQUIRED` |
  | 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA` |
  | 429 | `RATE_LIMITED`, with a `Retry-After` header and `details.retryAfterSeconds` |
  | 503 | `RETRYABLE_TEMPORARY`: Firestore contention, or token verification temporarily unavailable. Retry with backoff |

- **Idempotency:** state-changing requests may send `Idempotency-Key` (8–80 of `[A-Za-z0-9-]`). Only successful responses are stored and replayed for 24 h, marked with `Idempotent-Replay: true`. A retry after a 4xx runs again.
- **Compression:** request bodies may be `Content-Encoding: gzip`. Inflation is capped at the route's body limit, so a compression bomb gets 413. The app gzips bodies over 4 KB.
- **Conditional GET:** `GET /v1/sessions/{id}` returns `ETag: "<viewHash>"`, and `If-None-Match` with the same value returns a body-less 304.
- **Caching:** every response is `Cache-Control: private, no-store`.
- **Rate limits:** per uid, per function instance (token buckets in `api/http.ts`):

  | Bucket | Limit | Routes |
  |---|---|---|
  | `default` | 300/min | everything not listed below |
  | `poll` | 240/min | `GET /v1/sessions/{id}` |
  | `location` | 60/min | location batches |
  | `capture` | 20/min | capture init, photo upload, complete |
  | `join` | 12 failed lookups/h | invite preview and redeem (only failures count) |
  | `friend` | 30/h | friend requests, invite-link rotation, person link requests |
  | `export` | 30/h | exports |
  | `account` | 10/h | delete account, delete night, delete my data, revoke |

  Cloud Run itself returns a plain 429 when every instance is saturated, and the app backs off from that too.
- **Body limits:** 1 MB JSON by default. Photos are JPEG up to 8 MB (`MAX_PHOTO_BYTES`), and a batch holds at most 500 samples.

## Routes

Paths are relative to the base URL. The OpenAPI file has the request bodies and response shapes.

### Health and time
| | |
|---|---|
| `GET /healthz` | Liveness, `{ok:true}`. Public |
| `GET /v1/time` | `{serverTime}` for clock sync. Public |

### Me and devices
| | |
|---|---|
| `GET /v1/me` | Profile, counts, pending invites, active nights |
| `PATCH /v1/me` | Display name, handle, preferences |
| `DELETE /v1/me` | Delete the account: own tracks and photos everywhere, social graph, profile, auth user |
| `POST /v1/devices/push-token` | Register the FCM token for this device |
| `POST /v1/devices/live-activity-token` | Set this device's Live Activity push-to-start token, or null to opt out |

### Friends, people and groups
| | |
|---|---|
| `GET/POST /v1/friends/requests`, `POST /v1/friends/requests/{id}/respond` | Friend requests |
| `GET /v1/friends`, `DELETE /v1/friends/{uid}`, `POST /v1/friends/{uid}/block`, `DELETE /v1/blocks/{uid}` | Friends and blocks |
| `POST /v1/friends/invite-token/rotate` | New personal friend-invite link |
| `GET/POST /v1/people`, `PATCH /v1/people/{id}`, `POST /v1/people/{id}/merge` | Saved people |
| `POST /v1/people/{id}/link-requests`, `GET /v1/people/link-requests`, `POST /v1/people/link-requests/{id}/respond` | "This is me" account links |
| `GET/POST /v1/groups`, `PATCH/DELETE /v1/groups/{id}` | Reusable groups |

### Nights
| | |
|---|---|
| `POST /v1/sessions` · `GET /v1/sessions` | Create a night with its crews' people and, optionally, people sitting out (`bench`); it comes with a night code. Crew names in the request are ignored: crews are named after their people (ADR 0019) · list my nights (paged, searchable) |
| `GET /v1/sessions/{id}` | **My sanitized view** of the night (the same document as the Firestore listener). ETag / 304 |
| `DELETE /v1/sessions/{id}` | Organizer deletes the whole night: the Firestore subtree and GCS objects |
| `POST /v1/sessions/{id}/invites` | Show or regenerate the night code, or directly invite a friend |
| `POST /v1/invites/preview` · `POST /v1/invites/redeem` | Look up a code (with `suggestedPersonId`, the roster name this account most likely is, `claimedPersonIds`, names other phones play as, and `sittingOut`) · join, choosing a crew and optionally `personId`, the name the joiner plays as (ADR 0018). Joining as someone sitting out puts them on a crew (ADR 0019) |
| `PATCH /v1/sessions/{id}/setup` | Between-round editor, for any phone in the night: title, rules, crews, and where everyone is (crew rosters and `bench`). Every phone follows its owner, and someone on no list leaves the night with their phone. A removed crew's people sit out unless placed elsewhere. `moves: [{uid, teamKey: null}]` takes a phone out while its owner keeps playing (ADR 0014, 0019) |
| `POST /v1/sessions/{id}/consent` | Tracking and route-sharing consent for this night |
| `POST /v1/sessions/{id}/ready` | Ready mark for my crew, with a preflight health report. Not for a phone sitting out |
| `POST /v1/sessions/{id}/next-round` | Set up the next round (hiding crew, seek mode). Re-targets a READY round |
| `POST /v1/sessions/{id}/complete` | End the night |
| `POST /v1/sessions/{id}/keep-photos` | My crew opts in to keeping confirmed photos past 30 days |
| `DELETE /v1/sessions/{id}/my-data` | Delete this phone's tracks, the pins released from its fixes, and photos it took |
| `POST /v1/sessions/{id}/revoke` | Organizer incident response: deny all access, invalidate codes, end Live Activities |

### Rounds
| | |
|---|---|
| `POST …/rounds/{rid}/start` | Start, once every crew is ready. Blocking problems fail; warnings (such as stale GPS) fail until resent with `acknowledgeWarnings: true` |
| `POST …/rounds/{rid}/pause` · `…/resume` · `…/abort` | Manual or safety pause · resume vote · abort with a reason |
| `POST …/rounds/{rid}/location-batches` | Private GPS samples and health. Can release a waiting ping |
| `GET …/rounds/{rid}/my-track` | The caller's **own** samples only |
| `PUT/DELETE …/rounds/{rid}/live-activity/{deviceId}` | Register or remove this round's Live Activity push token and clock offset |
| `POST …/rounds/{rid}/captures/init` | Seeker: a short-lived upload ticket (chase only) |
| `PUT …/rounds/{rid}/captures/{cid}/photo` | Upload the JPEG. The server strips metadata |
| `POST …/rounds/{rid}/captures/complete` | Submit the claim. The official time is this moment |
| `GET …/rounds/{rid}/captures/{cid}/photo` | The photo, re-authorized on every read |
| `POST …/rounds/{rid}/captures/{cid}/decision` | Hiding crew confirms or rejects |
| `POST …/rounds/{rid}/captures/{cid}/dispute` | After the round: propose accept-as-catch or keep-rejected |

(`…` = `/v1/sessions/{id}`)

### History and analytics
| | |
|---|---|
| `GET …/rounds/{rid}/summary` | Round recap: only after the round ends, only to its phones |
| `GET …/rounds/{rid}/routes` | Per-crew routes, under the same conditions plus route-sharing consent |
| `GET /v1/sessions/{id}/analytics` | Night scorecard with censoring and comparability flags |
| `GET /v1/analytics/people/{personId}` | Crew-attributed stats for a person, across nights I played |
| `GET /v1/export/sessions/{file}` | CSV or JSON export. No GPS |

## Not on the public API

The deadline worker isn't reachable through `api`, and unknown routes return 404. Deployed, it's the private `tick` task-queue function plus the scheduled `watchdog` and `retention` functions. Locally, `backend/src/worker/app.ts` serves `/internal/rounds/tick` (aliases `/internal/pings/fire`, `/internal/capture/expire`, `/internal/round/timeout`), `/internal/watchdog/repair` and `/internal/retention/sweep` on 127.0.0.1:8788, behind a shared secret.
