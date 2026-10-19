# Permissions & threat model

## Assets
1. **Live hider location** during HEAD_START/CHASE/CAPTURE_PENDING/PAUSED (highest sensitivity — fairness and physical safety).
2. Raw GPS tracks of both operators (whereabouts history).
3. Catch photos (may include bystanders).
4. Social graph, rosters of non-account guests.

## Trust boundaries
* **Clients** (two iPhones) are untrusted. They hold a Firebase ID token and can read exactly one Firestore document: their own `sessions/{sid}/views/{uid}` while `members/{uid}.active == true`.
* **Public API** (`api` Cloud Function, `allUsers` invoker, Firebase-token auth in-app) can read/write everything; enforces per-action authorization derived from session membership.
* **Private worker** (`tick` task-queue function plus the scheduled `watchdog` and `retention` functions). There's no public invoker: `run.invoker`, and enqueuer on the `tick` queue, belong only to the `manhunt-backend@` service account, which every function runs as. `tick` also checks that the Cloud Tasks OIDC token's email is that account. Firebase client tokens never reach these functions. The local dev worker (`scripts/dev.sh`, tests) is a secret-gated twin that is never deployed.
* **Storage**: private bucket, uniform bucket-level access, public-access prevention enforced; Storage rules deny all client access. Photos are uploaded and downloaded only through the authorized API.

## Enforcement (not UI hiding)

| Threat (spec §11 hard negative test) | Control | Test |
|---|---|---|
| Seeker (even as host) reads hider raw path via API | No raw-location endpoint exists; `my-track` filters by caller uid; summaries/routes require a finished round | `tests/security/authorization.test.ts` |
| Guess a Firestore path (points, rounds, pings, captures, other views) | `firestore.rules` deny-all except own view | `tests/security/firestore-rules.test.ts` |
| Read a private bucket object | Storage rules deny all; bucket is private; photo reads re-check round operators | authorization tests (outsider 404) |
| Use a leaked/other user's view | Rules require `request.auth.uid == uid` and active membership; no list queries | rules test |
| Change role via JSON payload | Strict zod schemas reject unknown keys; role/team derived from membership | "role/team smuggling" test |
| Call scheduler endpoints | Not on the public API (404); deployed `tick`/`watchdog`/`retention` have no public invoker and `tick` checks the caller is the backend SA; the local worker rejects anonymous, wrong-secret and Firebase tokens | `tests/security/functions-surface.test.ts`, `tests/unit/functions.tasks.test.ts`, worker tests |
| Retroactive reveal of late (offline) uploads | Eligibility requires `receivedAt ≤ deadline` | unit + integration ("late uploads") |
| Reveal positions from a rejected-claim pending interval | Samples recorded during any pause are ineligible | unit test |
| Duplicate/inconsistent pings under retries | Transactional tick + `tx.create(pings/p{index})` | "concurrent ticks" test |
| Seeker host force-confirms own claim | Only `round.hiderUid` may decide; claimant ≠ reviewer | unit + integration |
| Third operator joins | Invite single-use; team slot must be empty; distinct UIDs enforced at start | gameplay test |
| Upload timing as a movement side-channel | Heartbeat batches every ~15 s regardless of motion; opponent sees 30 s-bucketed heartbeat only | view unit test |
| Coordinates in logs | pino redaction of coordinate keys; request bodies never logged; audit events carry no coordinates | code review |
| Coordinates in push notifications | Notification intents carry kind/title/body only | code review |
| EXIF GPS in photos | Client re-renders JPEG; server strips APP1–APP15 + COM segments | integration test checks GPS/serial strings removed |
| CSV injection in exports | Leading `= + - @` neutralized | code |

## Abuse limits
Per-uid token buckets (per function instance): default 300/min, location 60/min, capture 20/min, invites 20/h, friend actions 30/h, exports 30/h, account deletion 10/h. Page sizes capped (sessions ≤ 50, batches ≤ 500 samples, photos ≤ 8 MB JPEG, ≤ 20 claims per seeker per round). Effective limits scale with instance count — acceptable for a friends-only app (`maxInstances` is 5 for `api`, set in `backend/src/functions/index.ts`).

## Device security
Firebase Auth tokens live in the Keychain (SDK default). The offline GPS queue and unsent photos are AES-GCM encrypted with a `ThisDeviceOnly` Keychain key and written with `completeUntilFirstUserAuthentication` protection (required so background location writes work while locked). Everything is purged on logout and account deletion. Firestore cache is memory-only.

## Incident response
`POST /v1/sessions/{id}/revoke` (organizer): invalidates invites, deletes all views, deactivates memberships (rules then deny), marks the session revoked; audit event retained without coordinates. Account deletion and per-night "delete my data" remove raw points, route polylines, released pins of the deleting hider, track archives and photos.

## Known limitations
* Operators control their own GPS; a hider can fake location on their own phone. The app guarantees *scheduling and access control*, not truthful GPS.
* A hider force-quitting the app stops tracking; the opponent sees "Tracking stopped/No signal" and pings become "unavailable".
* Rate limiting is per instance, not global.
