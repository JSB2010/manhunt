# ADR 0013 — Crews with several equal phones, up to three crews, one night code

**Status:** accepted, joining and moves updated by ADR 0018 · **Supersedes:** ADR 0004 (in part), ADR 0008 (pause/resume parties) · **Spec:** §1 ("exactly two participating phone operators"), §3.2, §7.1

**Context.** Real nights have more than two phones. Several people on a crew want to follow the game, any of them may need to act (confirm a catch, pause), and some nights split into two seeking crews. The v1 model had exactly one operator phone per crew, two crews, and a host who alone could start, invite and set up rounds.

**Decision.**
* **Crews.** A night has two or three crews (`A`, `B`, `C`). Each crew has a roster of names (people without the app stay names) and 1–5 operator phones (`Team.operatorUids`). Every phone is equal; any one phone acts for its crew. A phone is on at most one crew.
* **Rounds.** One crew hides; every other crew seeks. With two seeking crews the round picks `seekMode`: `TOGETHER` (a catch is credited to every seeking crew) or `RACE` (credited to the claiming crew). Credit is `catchCreditTeams` — attribution, never a round winner.
* **Snapshot authority.** `round.operatorsByTeam` is frozen when a round starts from each crew's phones with tracking consent. Every in-round permission (uploads, ping sources, claims, decisions, pauses, aborts) and every post-round artifact (summary, routes, photos) is checked against that snapshot. A phone that joins or moves mid-round is a spectator until the next round: it gets no pins, no claim and no ping log.
* **Who may do what.**
  * Start: any phone of a playing crew, once every crew in the round has a ready mark set by one of its eligible phones.
  * Claim: any seeking-crew phone; one pending claim at a time; 20 claims per crew per round.
  * Decide: any hiding-crew phone. Concurrent decisions serialize in the transaction; the loser gets `STALE_PHASE` "already decided".
  * Manual pause: proposed by one side (hiders or seekers) and accepted by a phone on the other side. Two seeking crews cannot freeze the hiders on their own.
  * Resume: one hider vote and one seeker vote. Safety pause and abort: any phone in the round.
  * Disputes: settled when the hiding crew and the claiming crew agree; a third crew neither votes nor blocks.
* **No lead phone.** Start, invites, between-round edits, next round and ending the night are any-operator actions. Only deleting or revoking the night stays with the organizer, which moves to another phone if the organizer deletes their account.
* **Pings with several hider phones.** One pin per ping: the freshest eligible fix across the hiding crew's phones; within 10 s the more accurate fix wins. Spike checks run per phone. No averaging — a split crew would produce a location nobody is at. The source phone (`PingRelease.sourceUid`) is server-only.
* **Distances and routes.** Per crew, from the crew's phone with the best GPS coverage (`round.routeSourceUids`, server-only). Never per person.
* **Joining.** One reusable night code per night (stored server-side so any phone can show it again), valid until the night ends. The joiner picks a crew (default: the crew with the fewest phones). Regenerating revokes the old code. Only failed code lookups count toward the brute-force limit.
* **Consent.** Route sharing is checked against the phones that played the round. Withdrawing consent drops that phone from the round; the round aborts only if its crew has no phone left.

**Consequences.** The secrecy invariant is unchanged: seekers still receive released pins only, and no view, API response or export names which hider phone a pin came from. Views and requests changed shape (`seekingTeams`, `operators`, `crewStatus`), so the backend and the app ship together.
