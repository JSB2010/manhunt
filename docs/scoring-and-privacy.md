# Scoring, distances and data retention

## Time definitions (implemented in `backend/src/domain/clock.ts`, `engine.ts`)

| Field | Definition |
|---|---|
| `roundStartAt` | Server time of the host's start request |
| `chaseStartAt` | `roundStartAt + headStartSeconds + head-start pauses` (official deadline, not processing time) |
| Ping *n* | Effective chase time `n × pingIntervalSeconds` (ping 0 at chase start) |
| `officialFoundAt` | Server time the completed claim was accepted (`captures/complete`), finalized on hider confirmation |
| `observedChaseSeconds` | Effective chase time at `officialFoundAt` (pauses and claim-review windows excluded). For timeouts: the cap (right-censored) |
| `roundElapsedSeconds` | Wall-clock `officialEnd − roundStartAt` (display only, not a score) |

Example (spec §3.4): start 8:00, head start 10 min → first ping & seekers start 8:10, then 8:20, 8:30; photo submitted 8:36, confirmed 8:38 → **26:00**. Verified by `tests/unit/engine.test.ts` and the emulator gameplay test.

## No single-round winner
`RoundResult` has no winner field. The night scorecard (`scoring.ts`) computes per crew, **only over rounds it hid**: `hideRoundCount`, `hideSurvivalTotalSeconds`, `hideSurvivalAverageSeconds` (flagged `IncludesCensored` when any round timed out), `caughtOnlyHideAverageSeconds`, plus `seekCaptureAverageSeconds` over caught rounds it sought.

A stronger hiding crew is named only when the comparison is **COMPARABLE**: equal valid hide-round counts, identical rules fingerprints, no censored rounds, no aborted rounds. Otherwise status is **PROVISIONAL** (with reasons `UNEQUAL_HIDE_ROUNDS`, `RULES_DIFFER`, `CENSORED_ROUNDS`, `ABORTED_ROUNDS`) or **INSUFFICIENT**, and only descriptive statistics are shown.

Timed-out rounds are recorded as `observed ≥ cap, outcome TIMED_OUT, isRightCensored`, never as a catch at the cap.

## Person analytics (crew-attributed)
`personAnalytics` attributes everything to the crew a person was rostered on in that round (`hidingRosterSnapshot`/`seekingRosterSnapshot`), never to the individual: rounds their crew hid/sought, crew averages, paired-night outcomes, crew compositions (fingerprint of sorted canonical person ids), co-players, and — only for a linked account — rounds they were the phone operator. Results include a small-sample note and use only nights the requesting user participated in. Merged duplicate people resolve to the canonical id; historical snapshot names are never rewritten.

## Distances (`backend/src/domain/geo.ts`)
* Inputs: accepted consecutive samples of one operator (proxy for the crew).
* Ignored: accuracy worse than 50 m; jitter below max(5 m, ½ × mean accuracy) (the anchor is not advanced, so slow real walking still accumulates); spikes faster than 12 m/s (on foot) / 60 m/s (car); straight lines across gaps > 120 s (counted as gaps, reported).
* Reported separately: hiders on foot **total** (head start + chase), hiders on foot **chase**, seekers by car **chase**. Never combined.
* Coverage = time spanned by gap-free consecutive samples / window. Quality: GOOD (≥80 % and ≥10 samples), ESTIMATED (≥25 %), INSUFFICIENT.
* Routes: Douglas–Peucker at 8 m (doubling if > 4000 points), split at gaps, nothing interpolated.

## Retention defaults (product defaults, not legal claims)

| Data | Default | Mechanism |
|---|---|---|
| Raw GPS points | 30 days after recording | `expireAt` Firestore TTL + daily sweep backstop |
| Simplified routes + stats | Until the night is deleted or an operator deletes their data | `routes/{rid}`, `roundSummaries/{rid}` |
| Raw track archives (GCS) | Until session/my-data deletion; bucket backstop 400 days | `sessions/{sid}/rounds/{rid}/tracks/{teamId}/{rev}.geojson.gz` |
| Unconfirmed/rejected/expired photos | 7 days | daily retention sweep deletes the object |
| Confirmed photos | 30 days unless **both** operators opt in to keep (`keep-photos`) | retention sweep |
| Idempotency records | 24 h | TTL |
| Invites | expire after 60 min (configurable), deleted after 1 day | TTL + sweep |

## Deletion rights
* **Delete my data (per night)**: removes the caller's raw points, their crew's route polyline and track archive, coordinates of released pings of them as hider, and photos they took. Aggregate scores remain (disclosed in the UI). The organizer cannot override it.
* **Delete night (organizer)**: removes the whole Firestore subtree, invites and every GCS object for the session.
* **Delete account**: the above for every night, plus social graph, profile, handle, devices and the Firebase Auth user. Nights hosted alone are deleted; shared nights keep the other operator's history with this operator anonymized.
