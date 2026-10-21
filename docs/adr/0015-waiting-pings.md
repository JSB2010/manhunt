# ADR 0015 — Waiting pings

**Status:** accepted · **Supersedes:** ADR 0005 (missing pings at the deadline), spec §5.3 (in part)

**Context.** On cellular the hiders' phones regularly miss a ping deadline: a dead zone, a tunnel, a phone in a pocket that defers uploads. v1 released `NO_FRESH_FIX` and the seekers lost that ping entirely, even when a fix arrived seconds later.

**Decision.**
* At a ping deadline with no eligible hider fix on the server, the ping **waits** (`round.waitingPing = {index, deadline, since}`) instead of releasing nothing. Hider phones get a push ("Seekers are waiting on your ping"); seekers see a waiting chip. The view carries the index and times only — no coordinates.
* It releases as soon as a fix gets through, with the hiders' **current** position. A sample qualifies only if it comes from a hiding-crew phone in the round snapshot, was recorded at or after the missed deadline and after the last pause ended, is no older than the max GPS age at release time, and passes the accuracy, flag and per-phone spike checks. A backlog uploaded after an outage is therefore never revealed — only where the crew is now.
* The release is marked `delayed`, its age is measured against the release time, and seekers get a "Late ping" push.
* **Triggers:** the upload of a hiding-crew batch (re-checked inside the same transaction; it never fails the upload), every scheduled tick, and the once-a-minute watchdog as a backstop. There is no separate retry timer.
* **Never while paused.** A waiting ping releases only in an un-paused chase. Samples recorded during a pause stay ineligible, as before.
* **No pile-up.** If the next deadline arrives while a ping is still waiting, the waiting one is closed as `NO_FRESH_FIX` and the new one waits. A round that ends while a ping waits closes it as `NO_FRESH_FIX`, so ping counts stay exact.
* The on-time rule is unchanged: a sample received after its deadline is never revealed as that deadline's position.

**Consequences.** Seekers rarely lose a ping to bad coverage, at the cost of pings that arrive late and are labelled so. The schedule does not shift: the next ping stays on its original deadline.
