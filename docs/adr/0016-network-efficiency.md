# ADR 0016 — Network efficiency on cellular

**Status:** accepted (backend part; the app part lands with the iOS networking change) · **Updates:** ADR 0010

**Context.** Measured before this change, a phone pulled about 4–6 MB an hour and made about 18 requests a minute during a round:
* Every location batch from every phone ran a full transaction that re-rendered and rewrote **every** member's view. `renderedAt` always differed, so each write reached every phone.
* The app re-fetched its view over REST every 10 s.
* The view carried a 30 s heartbeat bucket for the opponent and the phone's own detailed health.

**Decision (backend).**
* **Changed-only view writes.** Each view's content hash, ignoring `renderedAt`, is kept on the member doc (`viewHash`). A transaction writes a phone's view only when its hash changed. Unchanged views never reach the phone.
* **Health off the transaction path.** A location batch writes the phone's health to its member doc with a plain update. A transaction and view render happen only when what other phones see changes: coarse tracking state, precise location, low power, permission, or tracking on/off. They also happen when the batch can release a waiting ping.
* **Coarse crew status** (`crewStatus`: phones live/total, best state, issues) replaces the opponent heartbeat; no timestamps. The watchdog ticks each active round once a minute, so stale/offline transitions still reach views. Unchanged views cost nothing.
* `myHealth` is no longer in the view (the phone knows its own state). `pingLog` carries the latest 10 entries plus `pingCount`.
* **Conditional GET.** `GET /v1/sessions/{id}` serves the phone's stored view doc (one read instead of four), with `ETag: "<viewHash>"`; `If-None-Match` returns a body-less 304.
* `stateVersion` comes from the session and round document versions, which only grow. A REST response that read older state can no longer outrank a newer listener snapshot.

**Decision (app, to follow).** Reconcile over REST only when the listener has been quiet for 45 s or on foreground, conditionally. Hider uploads stay at 15–20 s during the chase, with a fix uploaded just before each deadline; seekers upload every 90 s. On reconnect, the newest fix goes first. Request bodies are gzipped and health is sent only when it changes or once a minute.

**Measured (2026-10-21, `npm run e2e:crews`, 5 phones, 3 crews, 1-minute pings).** About 4 listener snapshots a minute per phone (~16 KB/min) and 3–5 REST calls a minute (~1–2.5 KB/min), down from a full rewrite of every view on every batch from every phone (≈20 snapshots a minute per phone with five phones). Every remaining snapshot is a real game event: start, chase start, a ping, a waiting or late ping, a claim, a decision. With 10-minute pings, snapshots drop to a handful per ping interval.
