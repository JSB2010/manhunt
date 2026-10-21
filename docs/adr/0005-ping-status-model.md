# ADR 0005 — Ping status values and pause handling

**Status:** accepted; missing pings superseded by ADR 0015 (waiting pings) · **Spec:** §9.2 `PingRelease.status: RELEASED | NO_FRESH_FIX | DELAYED | SKIPPED_PAUSED`

* `status` is `RELEASED` or `NO_FRESH_FIX`. Lateness is orthogonal, so it is a separate `delayed: boolean` + `dispatchLatencyMs` (a delayed release can still carry a valid point).
* `SKIPPED_PAUSED` never occurs: pauses (manual, safety, claim review) shift every future deadline by the paused duration, as §3.2/§3.3 require, so no slot falls inside a pause.
* **Conservative eligibility:** samples *recorded* during any pause or claim-review interval are never released later, even if the next deadline's 60 s window overlaps it (spec: "do not retroactively leak coordinates from the pending interval"). This can produce a `NO_FRESH_FIX` immediately after a resume; the UI says so.
* The hider's view also shows their own released pins ("Seekers saw you here") — it is their own location and already disclosed.
