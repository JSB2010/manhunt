# Permissions & threat model

## Assets
1. **Live hider location** during HEAD_START/CHASE/CAPTURE_PENDING/PAUSED (highest sensitivity — fairness and physical safety).
2. Raw GPS tracks of every phone in a round (whereabouts history).
3. Catch photos (may include bystanders).
4. Social graph, rosters of non-account guests.

## Trust boundaries
* **Clients** (every phone in a night, 1–5 per crew) are untrusted. They hold a Firebase ID token and can read exactly one Firestore document: their own `sessions/{sid}/views/{uid}` while `members/{uid}.active == true`.
* **Public API** (`api` Cloud Function, `allUsers` invoker, Firebase-token auth in-app) can read/write everything; enforces per-action authorization derived from session membership.
* **Private worker** (`tick` task-queue function plus the scheduled `watchdog` and `retention` functions). There's no public invoker: `run.invoker`, and enqueuer on the `tick` queue, belong only to the `manhunt-backend@` service account, which every function runs as. `tick` also checks that the Cloud Tasks OIDC token's email is that account. Firebase client tokens never reach these functions. The local dev worker (`scripts/dev.sh`, tests) is a secret-gated twin that is never deployed.
* **Storage**: private non-Firebase bucket (`<project>-manhunt-media`), uniform bucket-level access, public-access prevention enforced, no client IAM; Storage rules deny all client access to any Firebase-linked bucket. Photos are uploaded and downloaded only through the authorized API.

## Enforcement (not UI hiding)

| Threat (spec §11 hard negative test) | Control | Test |
|---|---|---|
| Seeker (even as host) reads hider raw path via API | No raw-location endpoint exists; `my-track` filters by caller uid; summaries/routes require a finished round; pins never name their source phone | `tests/security/authorization.test.ts` |
| Guess a Firestore path (points, rounds, pings, captures, other views) | `firestore.rules` deny-all except own view | `tests/security/firestore-rules.test.ts` |
| Read a private bucket object | Storage rules deny all; bucket is private; photo reads re-check round operators | authorization tests (outsider 404) |
| Use a leaked/other user's view | Rules require `request.auth.uid == uid` and active membership; no list queries | rules test |
| Change role or crew via JSON payload | Strict zod schemas reject unknown keys; role/crew derived from the round snapshot (`operatorsByTeam`); phone lists are never sent: the server derives them from the rosters (`placePhones`, ADR 0019) | "role/team smuggling" and "operator lists cannot be smuggled" tests |
| A phone sitting out reads or acts in a round | Its owner is on no crew, so its phone is in no round snapshot: no pins, uploads, claims, pauses, aborts, Ready or Start, and no post-round summary, routes or photos of rounds it didn't play. It may edit the night between rounds, like any phone in the night | `tests/security/sitting-out.test.ts`, `unit/views.privacy.test.ts` |
| Call scheduler endpoints | Not on the public API (404); deployed `tick`/`watchdog`/`retention` have no public invoker and `tick` checks the caller is the backend SA; the local worker rejects anonymous, wrong-secret and Firebase tokens | `tests/security/functions-surface.test.ts`, `tests/unit/functions.tasks.test.ts`, worker tests |
| Retroactive reveal of late (offline) uploads | Eligibility requires `receivedAt ≤ deadline` | unit + integration ("late uploads") |
| Reveal positions from a rejected-claim pending interval | Samples recorded during any pause are ineligible | unit test |
| Duplicate/inconsistent pings under retries | Transactional tick + `tx.create(pings/p{index})` | "concurrent ticks" test |
| Seeker (or host) confirms their own claim | Only hiding-crew phones in the round snapshot may decide; concurrent decisions serialize and the loser gets `STALE_PHASE` | engine unit tests; security "seeker cannot decide claims"; gameplay "any hider phone decides, the second decision loses" |
| Outsider joins, or a crew fills up with extra phones | Night code stored as a hash, valid only until the night ends (≤ 7 days), regenerating revokes it, failed lookups rate-limited (12/h); at most 5 phones per crew; a phone that joins mid-round is a spectator (no pins, claims or ping log) until the next round | security "guessing night codes", edge-cases "a crew takes at most five phones", gameplay join tests |
| Upload timing as a movement side-channel | Hider phones upload every ~15 s regardless of motion; other crews see only coarse `crewStatus` (phones live/total, state, issues), never timestamps (ADR 0016) | `unit/views.privacy.test.ts` |
| Coordinates in logs | pino redaction of coordinate keys; request bodies never logged; audit events carry no coordinates | code review |
| Coordinates in push notifications | Notification intents carry kind/title/body only | code review |
| Hider position on a Live Activity (Lock Screen, Watch, CarPlay — readable by anyone nearby) | Content is rendered only from the phone's own sanitized `RoundView`; it carries times, ping indexes, crew keys and the outcome, never coordinates, phone ids, names or free text (ADR 0017) | `unit/views.privacy.test.ts` (all phases, both roles, several phones), `security/authorization.test.ts` (every push a host-seeker's activity got) |
| Live Activity push tokens | Server-only `liveActivities` docs (12 h TTL), keyed by the caller's uid; registration only for a round in progress the phone plays; removed on revoke, delete-my-data and account deletion | `integration/liveActivities.test.ts`, `security/firestore-rules.test.ts`, `security/authorization.test.ts` |
| EXIF GPS in photos | Client re-renders JPEG; server strips APP1–APP15 + COM segments | integration test checks GPS/serial strings removed |
| CSV injection in exports | Leading `= + - @` neutralized | code |

## Abuse limits
Per-uid token buckets per function instance (`backend/src/api/http.ts`):

| Bucket | Limit | Applies to |
|---|---|---|
| `default` | 300/min | every route not listed below, including creating invites |
| `poll` | 240/min | the open night's view (`GET /v1/sessions/:id`) |
| `location` | 60/min | location batches |
| `capture` | 20/min | capture init, photo upload, claim submit |
| `join` | 12 **failed** lookups/h | invite preview and redeem (only failures count, against code guessing) |
| `friend` | 30/h | friend requests, friend-link rotation, person link requests |
| `export` | 30/h | exports |
| `account` | 10/h | delete account, delete night, delete my data, revoke |

Every 429 carries `Retry-After`, which the app honours with jitter. The `invite` bucket (20/h) is defined but not attached to any route. Sizes are capped too: sessions ≤ 50 per page, batches ≤ 500 samples, photos ≤ 8 MB JPEG, ≤ 20 claims per crew per round.

Effective limits scale with instance count, which is acceptable for a friends-only app. `api` runs up to 20 instances (`maxInstances` in `backend/src/functions/index.ts`) and scales to zero when idle.

## Device security
Firebase Auth tokens live in the Keychain (SDK default). The offline GPS queue and unsent photos are AES-GCM encrypted with a `ThisDeviceOnly` Keychain key and written with `completeUntilFirstUserAuthentication` protection (required so background location writes work while locked). Everything is purged on logout and account deletion. Firestore cache is memory-only.

## Incident response
`POST /v1/sessions/{id}/revoke` (organizer): invalidates invites, deletes all views, deactivates memberships (rules then deny), ends every Live Activity and removes its registrations, and marks the session revoked. The audit event is kept, without coordinates. Account deletion and per-night "delete my data" remove raw points, route polylines, released pins of the deleting hider, track archives and photos.

## Known limitations
* Operators control their own GPS; a hider can fake location on their own phone. The app guarantees *scheduling and access control*, not truthful GPS.
* A hider force-quitting the app stops tracking. The other crews see that crew's phones as stopped or without signal. If no hider phone has a fix, a ping waits (ADR 0015) and, if the next deadline arrives first, is closed as `NO_FRESH_FIX`.
* Rate limiting is per instance, not global.
