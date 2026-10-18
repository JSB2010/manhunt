# ADR 0010 — Firestore listener plus REST reconciliation

**Status:** accepted · **Spec:** §8.1 (role-scoped Firestore listeners, "reliable reconnect"), §14 reconnect behavior

**Context.** The two-simulator E2E showed the iOS Firestore SDK's watch stream to the emulator being half-closed and then reset by the peer (`READ_CLOSE`, then `Connection reset by peer`) about a minute after connecting. The SDK did not reconnect and kept reporting a healthy, non-cached listener, so the host's lobby froze while the server kept updating its view. The same silent failure mode occurs on real mobile networks (NAT timeouts, Wi-Fi ↔ cellular handoffs, captive proxies). A JS-SDK probe and an isolated iOS XCTest against the same emulator received every update, so the server, rules and view rendering were correct.

**Decision.** The listener stays the fast path, and the client reconciles on top of it:
* While a night is open, the app re-fetches its sanitized view over REST (`GET /v1/sessions/{id}`) every 10 s in the foreground and every 30 s in the background.
* Views are applied only if their `stateVersion` is not older than the last applied one, so a REST response never overwrites newer listener state.
* If the listener has delivered nothing for 60 s, the app toggles Firestore networking (`disableNetwork`/`enableNetwork`) and re-registers the listener.

**Consequences.** UI staleness is bounded to about 10 s even when the stream is dead, at a cost of about 6 small REST reads per minute per phone. Correctness never depended on the listener: pings, timers and state transitions are server-side, and REST returns the same sanitized view, so no privacy surface is added.
