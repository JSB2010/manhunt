# Data model

Where the data lives, who can read it and how long it's kept. The types are in `backend/src/domain/types.ts`, and the paths in `backend/src/services/repo.ts` (`paths()`). [ADR 0002](adr/0002-firestore-layout.md) explains how this departs from the spec's logical model.

**Access rule:** clients can read exactly one kind of document, their own `sessions/{sid}/views/{uid}`, and only while their membership is active. Every other document is server-only (Admin SDK), and clients write nothing (`firestore.rules`). Times in server documents are epoch milliseconds.

## Firestore

### Nights

| Path | Contents | Notes |
|---|---|---|
| `sessions/{sid}` | `SessionDoc`: title, date, `hostUid` (organizer), status, default `rules`, crews embedded as `teams.{A,B,C}` (name, colour, `operatorUids`, roster of `{personId, displayName}`), `memberUids`, `participantPersonIds`, `currentRoundId`, `roundIds`, `joinCode`, `keepPhotos`, `version` | The crews are tiny and always read with the session in the same transaction |
| `sessions/{sid}/members/{uid}` | `MemberDoc`: crew, `isHost`, `active`, consent, device health, `selfPersonId`, `viewHash` | Health is written without a transaction unless what others see changes (ADR 0016) |
| `sessions/{sid}/views/{uid}` | **The sanitized per-phone view**, rendered only by `domain/views.ts` | The only client-readable document. Written only when its content hash changes |
| `sessions/{sid}/rounds/{rid}` | `RoundDoc`: state, hiding and seeking crews, `seekMode`, `operatorsByTeam` snapshot, `rules` snapshot, roster snapshot, ready marks, `roundStartAt`, `chaseStartAt`, `pauses[]`, `phaseGeneration`, `pings[]` (`PingRelease`, with server-only `sourceUid`), `waitingPing`, the active claim, `result`, `routeSourceUids`, `active`, `summaryReady`, `version` | Authoritative. Every deadline derives from it |
| `…/rounds/{rid}/points/{pointId}` | `GpsPoint`: raw sample, `operatorUid`, `team`, `role` (stamped by the server), `recordedAt` (skew-corrected), `receivedAt`, flags, `expireAt` | Idempotent by `pointId`. **30-day TTL**. Never in any view |
| `…/rounds/{rid}/pings/p{index}` | One doc per released ping | `tx.create` makes a duplicate release impossible |
| `…/rounds/{rid}/captures/{claimId}` | `CaptureClaim`: claiming crew, `submittedAt`, `officialChaseMsAtClaim`, status, decision, dispute, photo object key and hash | 20 claims per crew per round |
| `sessions/{sid}/events/{id}` | Audit events | No coordinates |
| `sessions/{sid}/roundSummaries/{rid}` | Post-round recap: distances, coverage, ping list | Served only after the round, only to its phones |
| `sessions/{sid}/routes/{rid}` | Simplified per-crew polylines | Served only after the round, to its phones, with every phone's route-sharing consent |
| `sessions/{sid}/liveActivities/{uid}_{deviceId}` | Live Activity push token, clock offset, `sentVersion` (the round version last pushed; only newer versions go out) | **12 h TTL**. Removed on revoke, delete-my-data and account deletion |

**Nights recorded before crews** (before 2026-10-21) are stored in the old shape: one `operatorUid` per crew, rounds with one `seekingTeam` plus frozen `hiderUid`/`seekerUid`, per-side result fields, and pins without `sourceUid`. They aren't migrated. `domain/legacy.ts` upgrades them as they're read, through Firestore converters on the session and round paths in `services/repo.ts`. An old round's `operatorsByTeam` comes from its own frozen phones. Their stored views are `schemaVersion: 1`, so `GET /v1/sessions/{id}` renders a fresh view for them instead. Their round summaries keep the old shape (claims without `team`, and `routeStats` per side), which the app reads as is.

### Joining

| Path | Contents | Notes |
|---|---|---|
| `invites/{id}` | `kind: NIGHT` (the night code: only its SHA-256 is stored, reusable, valid until the night ends, at most 7 days) or `kind: DIRECT` (a friend invite: single use, 12 h) | TTL on `expireAt`. Regenerating the night code revokes the old one |

### People and social

| Path | Contents |
|---|---|
| `users/{uid}` | Profile: display name, handle, email, `selfPersonId`, preferences, friend-invite token, deletion state |
| `users/{uid}/devices/{deviceId}` | FCM token and APNs environment, app version, Live Activity push-to-start token |
| `handles/{handle}` | Handle reservation |
| `friendRequests/{id}`, `friendships/{id}` | Friend graph and blocks (`friendships.uids`) |
| `friendInviteTokens/{token}` | Personal friend-invite links (rotatable) |
| `people/{id}` | Saved people: names that may or may not be linked to an account. Merged duplicates resolve to a canonical id |
| `personLinkRequests/{id}` | "This is me" requests awaiting the person's owner |
| `groups/{id}` | Reusable groups: person ids, member and editor uids |

### Infrastructure

| Path | Contents | Notes |
|---|---|---|
| `idempotency/{hash}` | A stored successful response for an `Idempotency-Key` | **24 h TTL** |

### Indexes and TTL

`firestore.indexes.json` holds the composite indexes and these TTL policies: `points.expireAt`, `idempotency.expireAt`, `invites.expireAt` and `liveActivities.expireAt`. The daily retention sweep is the backstop for each. `points.latitude` and `points.longitude` have indexing turned off.

Production Firestore allows only **one** `array-contains` filter per query. The emulator doesn't enforce that, so `tests/unit/firestore.indexes.test.ts` does.

## Cloud Storage

Bucket: `<project>-manhunt-media` in production (private, uniform bucket-level access, public access prevention, 400-day lifecycle backstop). Locally it's the emulator's `demo-manhunt.appspot.com`. No client has IAM on the bucket. Every read and write goes through the API.

| Object | Written by | Removed by |
|---|---|---|
| `sessions/{sid}/rounds/{rid}/captures/{claimId}.jpg` | `PUT …/captures/{cid}/photo`, after the server strips metadata segments | Retention: 7 days if unconfirmed, rejected or expired; 30 days if confirmed, unless every crew opts in to keep. Also delete-my-data, delete-night and account deletion |
| `sessions/{sid}/rounds/{rid}/tracks/{phoneKey}/{rev}.geojson.gz` | `finalize.ts`, one per phone | Delete-my-data, delete-night, account deletion, the bucket backstop |

## What a view contains

A phone's view (`ViewDoc` in `domain/views.ts`) has:

- `session`: title, status, crews (`TeamView`: name, roster, operator phones with consent state), the phone's own crew, default rules, and the reusable night code (members only, null once the night ends);
- `round` (`RoundView`): state, the phone's role and crew (null for a spectator), hiding and seeking crews, `seekMode`, rules, ready marks, the time anchors (`roundStartAt`, `headStartEndsAt`, `chaseStartAt`, `timeCapAt`), the clocks (`accumulatedMs` + `runningSince`), next ping time and index, `waitingPing` (index and times only), `pingCount` and the latest 10 `pingLog` entries;
  - `pins`: the last *N* released pins, each with index, times, the coordinates of the *released* sample, accuracy, age and `delayed`. There's no phone id. Spectators get none;
  - `captureRequest` (hiding crew only) or `myClaim` (the claiming phone), plus `claimByTeam`;
  - pause, pending-pause and resume-vote state, `lastClaimOutcome`, and `result` once the round ends;
  - `crewStatus` per crew: phones live/total, the best tracking state and coarse issues, with no timestamps;
- `previousRounds` (round briefs) and `nextRound` (index and suggested hiding crew);
- `viewHash` (content hash, also the REST ETag) and `stateVersion` (only grows, so an older REST response never replaces a newer snapshot).

It never contains raw samples, the latest hider position, hider routes during a round, which phone a pin came from, or another phone's detailed health. `tests/unit/views.privacy.test.ts` enforces this.
