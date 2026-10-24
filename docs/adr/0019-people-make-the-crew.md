# ADR 0019 — People make the crew: phones belong to people, crews are named by their people

**Status:** accepted, night scorecard extended by [0020](0020-stats-story-first.md) · **Updates:** ADR 0013 (crews, who may edit), ADR 0014 (between-round editor, night comparison), ADR 0017 (Live Activity crew label), ADR 0018 (moves) · **Spec:** §2 (people and crews), §6.2 (night scorecard)

**Context.** A real night (five rounds, seven phones, crews reshuffled four times, people arriving and leaving) showed how the crew model breaks once a night is fluid:
* Every crew was two lists: names (`Team.roster`) and phones (`Team.operatorUids`). The editor showed them in separate sections. A phone could be moved with a picker, and since ADR 0018 its owner's name went with it. A name could only be deleted and added again, and the saved-people picker refused anyone still listed on another crew. Moving a name never moved its phone.
* There was no way to have someone sit out a round, or to list someone who hadn't arrived yet. People typed in at the start were credited with every round their crew played, including the rounds before they arrived. Two late arrivals were credited with three rounds each that they missed.
* "Remove" on a phone removed the phone but left the name. That was what we wanted for someone whose battery died and who kept playing. But there was no way to say "this person went home".
* A crew was a slot with a typed title ("Crew A"). The title stayed while its people changed: History, notifications, the night scorecard and the Lock Screen said "Crew A" for different groups of people every round. The scorecard added up "Crew A" across those rounds.
* The night comparison checked only that each crew hid with the same people in each of its own hiding rounds. With two crews each hiding once, swapping people between the two hides still counted as `COMPARABLE`.
* A rules change between rounds made the comparison `PROVISIONAL`, but nothing said what changed or when.

**Decision.**
* **One list of people.** A crew is its people (`Team.roster`). A night also has **sitting out** (`SessionDoc.bench`): people still in the night who aren't playing the next round, such as someone taking a break or someone who hasn't arrived yet. A person is on at most one crew or on the bench.
* **Phones belong to people.** Every phone is linked to the person who carries it (`MemberDoc.rosterPersonId`, ADR 0018). A phone's crew is always its owner's crew. After every change the server places the phones (`crews.placePhones`): an owner on a crew puts the phone on that crew, and an owner sitting out puts the phone on the bench. If the owner was removed from the night, the phone leaves the night too. `Team.operatorUids` is still stored, because round snapshots, permissions and queries read it, but no request sets it directly.
  * A phone with no owner, from a night before the link, keeps its crew, and its account's own person is added there.
* **Sitting out.** A phone whose owner sits out stays in the night as a spectator. It gets the lobby, but no Ready, no tracking and no pins. It can't start rounds and is not in any round snapshot. A phone joining with the night code as a person who is sitting out puts that person on a crew: the one they pick, or the crew with the fewest phones. "Who are you?" lists the people sitting out too.
* **Edits** (`PATCH /setup`, between rounds as before):
  * `teams[k].roster` and `bench` place people.
  * People of a removed crew who aren't placed elsewhere in the same edit sit out instead of disappearing.
  * Removing a person from every crew and the bench removes them from the night, and their phone with them. The organizer can sit out but can't be removed.
  * `moves` stays for phones. `{uid, teamKey: null}` removes only the phone: the person stays and keeps playing without one, for example after their battery dies. `{uid, teamKey: k}` (older apps) moves the phone's owner to `k`.
  * Crew `name` and `color` in requests are accepted and ignored.
* **Who may edit.** Any phone in the night may edit crews and rules, set up the next round, show the night code or end the night, including a phone that is sitting out. Ready and Start stay with phones on the round's crews. In-round authority is unchanged: it comes from the snapshot.
* **Crews are named by their people.** The server sets `Team.name` from the roster on every change, using first names in roster order:
  * "Sasha"
  * "Sasha & Marco"
  * "Sasha, Marco & Theo"
  * "Sasha, Marco & 3 more"
  * Two people with the same first name get their last initial ("Marco B.", "Marco R.").
  * A crew with nobody on it is named for its colour: "Blue crew", "Orange crew", "Green crew".

  Each round freezes the names (`round.teamNames`, `RoundBrief.teamNames`), so History says who hid and who sought in every round. Colour stays the crew's slot: blue, orange or green. Typed crew names are gone. Messages agree with the number of people ("Sasha hides", "Sasha & Marco hide").
* **Lock Screen.** The Live Activity's `crewName` is the crew's colour ("Blue crew"), never people's names: anyone near a locked phone can read it.
* **Night scorecard.**
  * The night comparison counts crews as changed (`ROSTERS_CHANGED`) when any crew's people differ between any two rounds, not only between a crew's own hides.
  * New `matchups`: rounds grouped by the same crews (sets of people, whatever their colour) under the same rules. Each matchup gets its own comparison, with the same tests as the night comparison.
  * New `people`: per person, rounds hidden and sought, their crew's average hiding time and the catches credited to their crew. These are crew-level results, labelled as such.
  * New `changes`: before each round, who joined, left, sat out or moved crews, and which rules changed.
  * The per-crew `teams` totals and `comparison` stay, for older apps and exports.

**Consequences.**
* Rounds are credited to the people who actually played them. A late arrival sits out until they arrive, and someone who leaves is removed or sits out.
* The editor is one board of people: drag between crews and Sitting Out, or use a person's menu. A phone shows as a badge on its owner.
* No new data reaches phones that couldn't already see it:
  * `session.sittingOut` lists names and phones of the same night, like `teams`.
  * Spectating phones get no pins, as before (`views.privacy.test.ts`).
  * The Lock Screen shows less than before.
* Older apps keep working against the new backend: they read `team.name` (now people's names) and send rosters and moves, which the server interprets as above. They can't show or set sitting out.
* Nights recorded before this change keep their stored crew names. Relabelling them is a data repair, not part of this change.
* Proven by:
  * `tests/unit/crews.test.ts`: labels, placing phones, sitting out.
  * `tests/unit/scoring.test.ts`: matchups, people, changes, the comparison fix.
  * `tests/unit/views.privacy.test.ts`.
  * `tests/integration/crews-people.test.ts`: the editor, joins and spectating.
  * `tests/security/authorization.test.ts`: what a phone that is sitting out may do.
