# ADR 0003 — One idempotent "tick" handles every deadline kind

**Status:** accepted · **Spec:** §5.4

**Decision.** Chase start, pings, claim expiry, time cap and pause-request expiry are all processed by `tickRound(round, now)`, which applies every event that is due in chronological order inside one Firestore transaction. `/internal/pings/fire`, `/internal/capture/expire`, `/internal/round/timeout` and `/internal/rounds/tick` are aliases. Cloud Tasks task names encode `(roundId, phaseGeneration, eventKey)`.

**Why.** A single derivation from persisted state is easy to prove idempotent: retries, duplicate tasks, stale generations and watchdog repairs all converge. Duplicate ping publication is additionally impossible because each release `tx.create`s `pings/p{index}`.

**Consequences.** A late wake-up releases every overdue ping (each selected strictly by its own deadline) and labels them `delayed` with the measured latency.
