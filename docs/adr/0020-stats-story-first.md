# ADR 0020 — Stats tell the story first: highlights, a night map, share cards, and the game map shows one round

**Status:** accepted · **Updates:** ADR 0011 (recap and history layout), ADR 0019 (night scorecard) · **Spec:** §6.1 (round results), §6.2 (night scorecard), §6.3 (person stats), §7 (screens)

**Context.** Playing full nights showed the data was good but badly presented:
* **The game map joined rounds.** A phone's own trail carried over from the previous round: Ready sets the next round's tracking context, so the "new round" check in `beginTracking` never fired, and the map drew a straight line from where one round ended to where the next began (often a drive across town). It also drew straight lines across tracking gaps.
* **The round recap was a list of rows.** Head start, pauses, ping counts, GPS coverage and route quality sat beside the outcome with the same weight. The catch photo came after the numbers, and nothing said whether a round was long or short for the night.
* **The night scorecard led with a verdict that was usually "Provisional".** Nights change crews, so the fair comparison rarely applies (ADR 0019). The page then read like a list of caveats. Distances had no per-person view, and there was no way to see "the longest round" or "who covered the most ground".
* History had two screens per night (detail, then scorecard). CSV and JSON export were the only way to share anything.

**Decision.**
* **The game map shows this round only.** The own trail belongs to a round (`OwnTrail.roundId`) and starts empty when the round changes, whatever the tracking context says. Fixes more than 120 s apart start a new segment, as recap routes do (`geo.ts`). A marker shows where this phone started the round.
* **Every stats screen has three tiers.** A headline (one sentence, one big number), highlights (a few tiles or badges with context), and details one tap away.
  * **Round recap:** the outcome, who hid and who sought, and the badges the round set; the catch photo; the map (start, end, catch and numbered pings), which opens full screen with a **replay scrubber** (spec §6.1's "routes with time markers"); the numbers as tiles; between rounds, tonight's rounds as bars and what's next. Pings, GPS coverage, pauses, claims and the timeline move to **Round Details**. Claims that can still be settled stay on the recap, first.
  * **The night:** one page from History, "Night So Far" and the end of a night. The verdict (a stronger crew only when the comparison is `COMPARABLE`, else a calm "No overall result" with the reasons), the night's **highlights**, the rounds as bars, the **night map**, crews by line-up, people (sortable), and Export Data. Deleting moves to the toolbar menu.
* **Highlights** (`Scorecard.highlights`, `scoring.nightHighlights`): single-round facts, each credited to the crews of that round. The longest hide, the fastest catch, and the most and least ground covered on foot and by car.
  * Aborted rounds never count. A hide that ran to the time cap counts as at least its cap and is marked "≥". The fastest catch is among caught rounds only.
  * Distances without usable GPS (`INSUFFICIENT`) are left out, and partial ones (`ESTIMATED`) are marked.
  * Each needs two rounds to compare. A "least" needs a value below the "most". Ties go to the earlier round.
  * They never rank crews over a night and never name a round winner (spec §6.1). The fair comparison is unchanged.
* **People** (`PersonNightStats`): new `footMeters`, `driveMeters` and `rounds` (each round as their crew played it: role, outcome, time, the crew's distance). A person's page shows their longest and shortest rounds. Everything stays crew-level and is labelled so (spec §6.3 "team-level elapsed time and distance"). There is no per-person distance: a crew's distance is its best-covered phone's (§3.4), and not everyone carries a phone.
* **Night map:** every round this phone played on one map. Each round has a numbered circle where its hiders started and an end marker (the catch, the time limit or an abort). **Rounds are never joined by a line.** One round can be focused (the others fade), and the seekers' driving can be shown. It loads each round's existing routes endpoint, so it shows nothing a phone couldn't already open round by round. Rounds it didn't play, or without every phone's consent, are listed as unavailable.
* **Share cards:** a round card (outcome, crews, a map snapshot of the routes, two or three numbers, its highlights), a catch-photo card, and a night card (verdict, highlights, rounds as bars). They are drawn on the phone (`ImageRenderer`, `MKMapSnapshotter`) from data it already shows, previewed, and handed to the share sheet. Nothing is uploaded. CSV and JSON stay under Export Data.

**Consequences.**
* No new data reaches any phone. Highlights and person rounds are computed from the same finished-round results the scorecard already returns (`scorecard.rounds`), carry no coordinates, and appear in exports too. The night map uses the per-round routes endpoint with its existing checks (finished round, round phone, consent).
* A share card with a map shows the round's routes as an image. It is made only when someone taps Share, after the round, from routes that phone may already see; what happens to it then is up to them, as with a screenshot. The app asks for "add to photo library" access (`NSPhotoLibraryAddUsageDescription`) only if they choose Save Image.
* Older apps ignore the new fields. The new app reads scorecards from older servers (no highlights, no person distances) and hides what's missing.
* Proven by:
  * `tests/unit/scoring.test.ts`: highlights (censored, aborted, unusable GPS, ties, Race credit, a lone catch), person rounds and distances, no coordinates.
  * `tests/security/authorization.test.ts`: during an active round, analytics has no highlight or person round from it, and no hider coordinates.
  * `ManhuntCrewsTests/StatsTests.swift`: the trail never spans two rounds and splits at gaps, the replay moves along simplified routes without crossing gaps, ranks, verdicts, highlight and recap wording, a person's longest and shortest, decoding with and without the new fields.
