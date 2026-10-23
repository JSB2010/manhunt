# Scoring, distances and data retention

## Time definitions (implemented in `backend/src/domain/clock.ts`, `engine.ts`)

| Field | Definition |
|---|---|
| `roundStartAt` | Server time of the start request (any phone of a playing crew) |
| `chaseStartAt` | `roundStartAt + headStartSeconds + head-start pauses` (official deadline, not processing time) |
| Ping *n* | Effective chase time `n × pingIntervalSeconds` (ping 0 at chase start) |
| `officialFoundAt` | Server time the completed claim was accepted (`captures/complete`), finalized on hider confirmation |
| `observedChaseSeconds` | Effective chase time at `officialFoundAt` (pauses and claim-review windows excluded). For timeouts: the cap (right-censored) |
| `roundElapsedSeconds` | Wall-clock `officialEnd − roundStartAt` (display only, not a score) |

Example (spec §3.4): start 8:00, head start 10 min → first ping & seekers start 8:10, then 8:20, 8:30; photo submitted 8:36, confirmed 8:38 → **26:00**. Verified by `tests/unit/engine.test.ts` and the emulator gameplay test.

## No single-round winner
`RoundResult` has no winner field. With two seeking crews, `catchCreditTeams` attributes a confirmed catch: RACE → the claiming crew, TOGETHER → every seeking crew. It is attribution, not a winner. The night scorecard (`scoring.ts`) computes per crew (two or three), **only over rounds it hid**: `hideRoundCount`, `hideSurvivalTotalSeconds`, `hideSurvivalAverageSeconds` (flagged `IncludesCensored` when any round timed out), `caughtOnlyHideAverageSeconds`, plus `seekCreditedCatches`/`seekCaptureAverageSeconds` over catches credited to it and `seekCaughtByOtherCrew` for RACE rounds another crew won.

A stronger hiding crew is named only when the comparison is **COMPARABLE**: every crew hid equally often, identical rules fingerprints (which include the number of seeking crews and the seek mode), each crew hid with the same people in each of its own hiding rounds, no censored rounds, no aborted rounds. Otherwise status is **PROVISIONAL** (reasons `UNEQUAL_HIDE_ROUNDS`, `RULES_DIFFER`, `ROSTERS_CHANGED`, `CENSORED_ROUNDS`, `ABORTED_ROUNDS`) or **INSUFFICIENT** (some crew never hid), and only descriptive statistics are shown.

Timed-out rounds are recorded as `observed ≥ cap, outcome TIMED_OUT, isRightCensored`, never as a catch at the cap.

## Person analytics (crew-attributed)
`personAnalytics` attributes everything to the crew a person was rostered on in that round (`rosterSnapshot[crew]`), never to the individual: rounds their crew hid/sought, crew averages, paired-night outcomes, crew compositions (fingerprint of sorted canonical person ids), co-players, and — only for a linked account — rounds they were the phone operator. Results include a small-sample note and use only nights the requesting user participated in. Merged duplicate people resolve to the canonical id; historical snapshot names are never rewritten.

## Distances (`backend/src/domain/geo.ts`)
* Inputs: accepted consecutive samples of one phone — per crew, the phone with the best coverage (a proxy for the crew, which moves together). Phones are never averaged.
* Ignored: accuracy worse than 50 m; jitter below max(5 m, ½ × mean accuracy) (the anchor is not advanced, so slow real walking still accumulates); spikes faster than 12 m/s (on foot) / 60 m/s (car); straight lines across gaps > 120 s (counted as gaps, reported).
* Reported separately, per crew: hiders on foot **total** (head start + chase), hiders on foot **chase**, each seeking crew by car **chase**. Never combined.
* Coverage = time spanned by gap-free consecutive samples / window. Quality: GOOD (≥80 % and ≥10 samples), ESTIMATED (≥25 %), INSUFFICIENT.
* Routes: Douglas–Peucker at 8 m (doubling if > 4000 points), split at gaps, nothing interpolated.

## Retention defaults (product defaults, not legal claims)

| Data | Default | Mechanism |
|---|---|---|
| Raw GPS points | 30 days after recording | `expireAt` Firestore TTL + daily sweep backstop |
| Simplified routes + stats | Until the night is deleted or a phone deletes its data (its crew's route is then recomputed from the crew's other phones) | `routes/{rid}`, `roundSummaries/{rid}` |
| Raw track archives (GCS) | Until session/my-data deletion; bucket backstop 400 days | `sessions/{sid}/rounds/{rid}/tracks/{phoneKey}/{rev}.geojson.gz` (one per phone; superseded revisions are removed when the recap is recomputed) |
| Unconfirmed/rejected/expired photos | 7 days | daily retention sweep deletes the object |
| Confirmed photos | 30 days unless **every crew** opts in to keep (`keep-photos`) | retention sweep |
| Idempotency records | 24 h | TTL |
| Night code | until the night ends (bounded at 7 days); regenerating revokes the old code | TTL + sweep |
| Direct friend invites | single use, 12 h | TTL + sweep |

## Deletion rights
* **Delete my data (per night)**: removes the phone's raw points and track archives, the coordinates of pins released from its fixes (`PingRelease.sourceUid`, server-only), and photos it took; its crew's route and distances are recomputed from the crew's other phones, or marked deleted if none remain. Aggregate scores remain (disclosed in the UI). The organizer cannot override it.
* **Delete night (organizer)**: removes the whole Firestore subtree, invites and every GCS object for the session.
* **Delete account**: the above for every night, plus social graph, profile, handle, devices and the Firebase Auth user. The phone leaves any round in progress (which aborts only if its crew has no other phone). Nights with no other phone are deleted; shared nights keep everyone else's history, the phone is anonymized and the organizer role passes to another phone.
