# ADR 0008 — Pause, resume and abort authority

**Status:** accepted · **Spec:** §3.2 pause behavior, §10.1 abort

* **Manual pause:** either operator proposes (90 s window); the *other* operator's confirmation starts it. (Spec says "host can propose"; we let either operator propose since the host has no special role.)
* **Safety pause:** immediate from either operator, conspicuous to both (time-sensitive push + full-screen overlay).
* **Resume:** both operators vote; the pause ends at the second vote. Prevents one crew restarting the clock while the other is not ready.
* **Abort:** either operator, with a reason (safety aborts labelled). Recorded as `ABORTED`, excluded from comparisons. Withdrawing consent mid-round also aborts.
* **Stop tracking (privacy/safety):** the in-game menu stops on-device tracking and triggers a safety pause so both crews see it.
