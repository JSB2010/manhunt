# ADR 0002 — Firestore layout differs slightly from the logical model

**Status:** accepted · **Spec:** §9.1 ("exact collection path names may differ")

* Crews are embedded in `sessions/{sid}.teams.{A,B}` (tiny, always read with the session in the same transaction) instead of a `teams` subcollection. Each crew still has a stable `teamId`, name, color, operator UID and roster snapshot of `{personId, displayName}`.
* Raw points live at `sessions/{sid}/rounds/{rid}/points/{pointId}`; pings at `…/rounds/{rid}/pings/p{index}` plus a server-only array on the round doc used for rendering; captures at `…/rounds/{rid}/captures/{claimId}`; audit events at `sessions/{sid}/events`.
* `invites/{id}` stores only a SHA-256 of the code (queried by hash), never the plaintext.
* All of these are server-only by rules. Only `sessions/{sid}/views/{uid}` is client-readable.
