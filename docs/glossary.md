# Glossary

Product terms with their names in code. Where the spec and the code differ, the code name is the one to search for.

| Term | In code | Meaning |
|---|---|---|
| Night | `SessionDoc`, `sessions/{sid}`, "session" | One evening of play. Open-ended: no round count, ended by any phone (ADR 0014) |
| Organizer | `hostUid`, `isHost` | The phone that created the night. Its only extra power is deleting or revoking the night, and it gets **no** extra visibility (ADR 0004, 0013) |
| Crew | `Team`, `TeamKey` `A`/`B`/`C` | A group that moves together. Two or three per night |
| Roster | `Team.roster`, `PersonRef` | The names on a crew. They need no account |
| Person | `people/{id}`, `personId` | A saved name with a stable id across nights, optionally linked to an account |
| Phone / operator | `operatorUids`, `operatorUid` | An account's iPhone playing for a crew. 1–5 per crew, all equal (ADR 0013) |
| Round snapshot | `round.operatorsByTeam` | The crews' consenting phones, frozen at start. All in-round authority comes from it |
| Spectator | `myRole: null` | A phone in the night but not in the round's snapshot. Sees no pins, claims or ping log |
| Hiding crew / seeking crews | `hidingTeam`, `seekingTeams`, `Role` `HIDING`/`SEEKING` | One crew hides, every other crew seeks |
| Side | `Side` `HIDERS`/`SEEKERS` | Pause and resume authority is between sides, not crews |
| Seek mode | `SeekMode` `TOGETHER`/`RACE` | With two seeking crews: share a catch, or credit only the claiming crew |
| Catch credit | `catchCreditTeams` | Which crews a confirmed catch counts for. Attribution, not a winner |
| Head start | `HEAD_START`, `headStartSeconds` | Time before the chase |
| Chase | `CHASE`, `chaseStartAt` | From the end of the head start until the catch, time cap or abort |
| Active states | `ACTIVE_ROUND_STATES` | `HEAD_START`, `CHASE`, `CAPTURE_PENDING`, `PAUSED`: the secrecy invariant applies |
| Ping | `PingRelease`, `pings/p{index}` | A released hider position at deadline *n* (ping 0 at chase start). Status `RELEASED` or `NO_FRESH_FIX` |
| Pin | `PinView` | A released ping as a seeker's view shows it |
| Waiting ping | `round.waitingPing` | A ping whose deadline passed without an eligible fix. It releases the hiders' current position as soon as one arrives (ADR 0015) |
| Delayed | `delayed`, `dispatchLatencyMs` | A release that went out after its deadline, labelled so |
| Sample / point | `GpsPoint`, `points/{pointId}` | A raw GPS fix. Server-only, 30-day TTL |
| Eligibility | `selectPingSample`, `selectLateSample` | The rules a sample must meet to become a ping |
| Claim / capture | `CaptureClaim`, `captures/{claimId}` | A seeker's photo catch. The official time is its submission |
| Capture pause | `PauseKind` `CAPTURE` | The clock freeze while a claim is reviewed |
| Dispute | `claim.dispute` | Settling a rejected or expired claim after the round. The hiding and claiming crews must agree |
| Pause | `PauseInterval` `MANUAL`/`SAFETY`/`CAPTURE`/`TECHNICAL` | Time excluded from the clock. Pauses shift every future deadline |
| Generation | `phaseGeneration` | Increments on every pause, resume and claim transition. Part of a task id |
| View | `ViewDoc`, `sessions/{sid}/views/{uid}` | A phone's sanitized read model. The only client-readable data |
| View hash | `viewHash` | Content hash of a view. Changed-only writes and the ETag (ADR 0016) |
| Crew status | `crewStatus`, `CrewStatusView` | Coarse phone health per crew: live/total, state, issues |
| Tick | `tickRound`, the `tick` function | Applies every due event for a round, idempotently (ADR 0003) |
| Watchdog | `GameService.watchdog`, the `watchdog` function | The once-a-minute backstop: re-ticks active rounds, re-enqueues wake-ups, finishes finalization |
| Finalization | `finalize.ts`, `summaryReady` | Post-round distances, routes, archives and summary |
| Rules fingerprint | `rulesFingerprint` | Hash of the rules that affect comparability, plus the number of seeking crews and the seek mode |
| Comparison status | `COMPARABLE`/`PROVISIONAL`/`INSUFFICIENT` | Whether a night may name a stronger hiding crew |
| Censored | `isRightCensored`, `TIMED_OUT` | The round hit its time cap. The time is a lower bound, not a catch |
| Live Activity | `liveActivityState`, `liveActivities/{uid}_{deviceId}` | The round on the Lock Screen and in the Dynamic Island (ADR 0017) |
| Night code | `invites` `kind: NIGHT`, `joinCode` | The reusable code to join a night. Only its hash is stored |
