# ADR 0014 — Open-ended nights

**Status:** accepted, the editor and the night comparison updated by ADR 0019 · **Supersedes:** `Rules.totalRounds`, `initialHidingTeam`, `alternateRoles` and the host role override

**Context.** Nights rarely go as planned: more or fewer rounds, teams reshuffled mid-night, rules tightened after a round. The fixed round count and forced A/B alternation got in the way.

**Decision.**
* A night has no round count. After a round, any phone can set up the next one, edit the night, or end it. The night never ends on its own.
* **Next round:** any crew may hide; the default is the crew that has hidden least (ties: the crew whose last hide was longest ago, then key order). Calling next-round while a READY round exists re-targets it (hider, seek mode).
* **Between-round editor** (`PATCH /setup`, any operator, LOBBY/BETWEEN_ROUNDS/READY): title, default rules, crews (add, rename, remove; at least two remain), rosters, and phone moves (`moves: [{uid, teamKey|null}]`, null removes a phone; the organizer's phone cannot be removed). Removing a crew moves its phones to the emptiest crew. Operator lists can only change through `moves`.
* A READY round is refreshed from the edited night. Ready marks survive only when roles and rules are unchanged and the marking phone is still on its crew.
* Ending the night discards an unstarted READY round and revokes the night code.
* **Random teams** are client-side: the app shuffles names into 2 or 3 crews and spreads phones, then saves through the same editor.

**Scoring.** A night comparison names a stronger hiding crew only when every crew hid equally often, rules are identical, each crew hid with the same people in each of its own hiding rounds, and no round was censored or aborted. Otherwise it is PROVISIONAL with reasons (`UNEQUAL_HIDE_ROUNDS`, `RULES_DIFFER`, `ROSTERS_CHANGED`, `CENSORED_ROUNDS`, `ABORTED_ROUNDS`). The rules fingerprint includes the number of seeking crews and the seek mode when more than one crew seeks.
