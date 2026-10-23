# Test matrix & results

Legend: ✅ automated and passing · 🟡 partially covered / simulator only · ⏳ requires physical iPhones (not yet run) · — not applicable.

## Automated suites (first run 2026-10-17; latest full backend and iOS unit run 2026-10-23 on macOS, Xcode 27.1, Node 24.18, Firebase CLI 15.28.1, JDK 21)

| Suite | Command | Result |
|---|---|---|
| Backend unit (domain, privacy invariant, OpenAPI contract, iOS-encoding schemas, Cloud Functions adapter + tick handler + task-queue scheduler) | `cd backend && npm run test:unit` | ✅ 154 / 154 (2026-10-23, ADR 0019: + crew names from people, phones following their owners, sitting out, matchups, per-person night tallies, what changed before each round, a seeking-side reshuffle making the night provisional, the Lock Screen naming crews by colour, a phone sitting out seeing nothing of the round) · 139 / 139 (2026-10-23: + roster matching for joining phones, a moved phone's owner moving with it, tracking nudges, wake-ups dispatched ahead of the deadline, APNs credential rejections and push-failure logging, crew names in round briefs) · 129 / 129 (2026-10-22: + nights stored before crews are upgraded on read; current and partial documents pass through) · 125 / 125 (2026-10-22: + Live Activity content privacy, server ↔ app contract fixture, ActivityKit payload shape, notifier skip) · 115 / 115 (2026-10-21, crews: several phones per crew, three crews, waiting pings, Race/Together credit, shuffler-independent scoring, privacy of source phones) |
| Backend integration + security (Auth/Firestore/Storage emulators, rules, deployed-functions surface) | `npm run test:integration` | ✅ 83 / 83 (2026-10-23, ADR 0019: + `crews-people.test.ts`, a night with someone not here yet, joining as them, moving people with and without phones, sitting out, leaving, taking a phone out, the organizer sitting out, an older app's edit; + `security/sitting-out.test.ts`, what a phone sitting out may read and do) · 71 / 71 (2026-10-23: + `night-replay.test.ts`, the joins, moves and crew deletion of 2026-10-22 and the resulting person stats; the tracking nudge; a catch decision racing two final uploads; a retried upload racing its first attempt, which failed with 500 before the fix; Live Activity pushes pausing after an APNs credentials rejection) · 66 / 66 (2026-10-22: + a night stored in the pre-crews shape: nights list, night detail from a schema-1 stored view, person stats, night analytics, CSV export, delete-my-data redacting only the lone hider's pins) · 62 / 62 (2026-10-22: + Live Activities end to end with a recording ActivityKit transport, token authorization and rules) · 53 / 53 (2026-10-21: open night with two phones on a crew and a third crew added mid-night; concurrent hider decisions; Race photo restriction; hider outage → waiting ping → current position on reconnect; night code cap/regenerate/brute-force; phone moves/removal; changed-only view writes and 304; gzip bodies incl. a bomb → 413; a joining account whose name is already on the roster isn't listed twice) |
| Real-time crews E2E (live stack, wall clock, 5 phones with Firestore listeners, 3 crews) | `npm run e2e:crews` | ✅ 2026-10-21: ping waited through a 65 s hider outage and released the current position 0.4 s after reconnect (no backlog point); 0 unreleased coordinates in seeker REST views or listener snapshots; Race catch credited to Crew C only, Crew B denied its photo; phone moved and any crew hid next; night ended by a phone. Bandwidth per phone with **1-min pings**: ~4 listener snapshots/min (~16 KB/min) and 3–5 REST calls/min (~1–2.5 KB/min) — vs. a full view rewrite on every batch from every phone before (≈20 snapshots/min per phone with 5 phones) |
| Real-time API E2E (live stack, wall clock, local scheduler → worker) | `npm run e2e:two-operators` | ✅ first ping seen 0.5 s after chase start; ping 1 0.7 s after its deadline; sample age 9 s; 0 unreleased coordinates in seeker view; official time = submission time |
| Real-time API E2E through the **deployable Cloud Functions** (Functions + Cloud Tasks emulators: `api` → task queue → `tick`) | `npm run serve:functions` (alternate ports), then `API_URL=http://127.0.0.1:<port>/demo-manhunt/us-central1/api npm run e2e:two-operators` | ✅ 2026-10-18: first ping seen 1.3 s after chase start; ping 1 0.2 s after its deadline; sample age 7 s; 0 unreleased coordinates in seeker view; photo upload (JPEG through the adapter, metadata stripped), catch, recap, round 2 role swap. The Cloud Tasks emulator ignores `scheduleTime`, so delivery timing here came from `tick`'s early-arrival wait-and-retry (ADR 0012). The first run, before that handling existed, failed at ping 0. |
| Backend typecheck | `npm run typecheck` | ✅ |
| iOS **Prod** configuration (unsigned build) | `xcodebuild build -scheme "ManhuntCrews Prod" -configuration Prod -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO` | ✅ 2026-10-20: your bundle ID and prod API URL from `Prod.local.xcconfig`, `GoogleService-Info-Prod.plist` bundled, emulators off, manual signing settings resolved |
| Manual signing helper | `scripts/ios-signing.sh csr` / `install` in a throwaway HOME + keychain with a self-signed stand-in certificate and CMS-signed fake profile | ✅ key/cert pair into an identity; profile checks (bundle, App Store type, push, certificate membership) and `Prod.local.xcconfig` output work. A real Apple certificate and upload are not yet exercised |
| Prod Firebase project | `firebase deploy --only auth,firestore:rules --project <prod-project-id>` | ✅ 2026-10-20: Email/Password enabled, rules live. Indexes/TTL need Blaze |
| iOS unit + listener integration (XCTest) | `xcodebuild test … -only-testing:ManhuntCrewsTests` | ✅ 64 passed, 1 skipped / 65 (2026-10-23 on iPhone 17 / iOS 27, ADR 0019: + the people board (moves, sitting out, adding someone already in the night, dropping a crew, shuffle), crew names like the server's, verb agreement, what-changed text, decoding views with and without `sittingOut`) · 58 passed, 1 skipped / 59 (2026-10-23 on iPhone 17 / iOS 27: + a removed crew's name in round briefs, readable recap timeline without lobby events, plain-words offline errors) · 55 passed, 1 skipped / 56 (2026-10-22 on iPhone 17 / iOS 27, with the Live Activity extension: + `LiveActivityContractTests` against `shared/fixtures/live-activity.json` and `LiveActivityTextTests`; the listener test skipped because the local stack wasn't running) · 47 / 47 (2026-10-21 on iPhone 17 / iOS 27: crews, shuffler, gzip, conditional reload, newest-first recovery, auth resilience, clock through device sleep; the listener test runs only when the local stack is up and the build points at it, e.g. `MH_DEV_HOST=127.0.0.1`) |
| iOS app build (Debug, simulator) | `xcodebuild build …` | ✅ 2026-10-22: app + `ManhuntCrewsWidgets` extension build with Xcode 27.1; no warnings in app or extension sources (test sources have 7 Swift 6 `Sendable` warnings in `AuthResilienceTests.swift`). The Live Activity UI itself is not yet checked on a simulator or device. CI (`.github/workflows/ios.yml`) builds Debug + Release and runs the unit tests on every iOS change |
| iOS Live Activity mapping and wording on Linux (superseded by the macOS run above) | SwiftPM harness compiling `GameModels.swift`, `JSONCoding.swift`, `LiveActivityShared/RoundActivityAttributes.swift` and `RoundActivityContent.swift` with Swift 6.4.1, running `LiveActivityTests.swift` (CoreLocation stubbed) | ✅ 8 / 8 (2026-10-22); a one-second drift in the mapping fails the contract test |
| iOS Release build for device (unsigned) | `xcodebuild build -configuration Release -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO` | ✅ 2026-10-23 after ADR 0019 (and the Prod scheme), with the `ManhuntCrewsWidgets` extension, no warnings in app or extension sources |
| Setup / deploy scripts | `bash -n scripts/setup-gcp-project.sh scripts/deploy-backend.sh`; every gcloud flag checked against `--help` (gcloud 580) | ✅ syntax only; never run against a project |
| Two-simulator E2E (real app ×2 + local stack) | `scripts/e2e-two-simulators.sh` | see "Two-simulator E2E" below |

### Spec §15.1 automated coverage

| Requirement | Where |
|---|---|
| Clock through pauses (incl. overlapping) | `unit/clock.test.ts`, `unit/engine.test.ts` (pauses) |
| First ping exactly at head-start end; repeat intervals | `unit/engine.test.ts`, `integration/gameplay.test.ts` round 1 |
| Max visible pin count | `unit/views.privacy.test.ts` (history 2), gameplay (history 1) |
| Invalid/stale/inaccurate GPS excluded | `unit/pingSelection.test.ts` |
| Photo accepted / rejected / expired | engine tests; gameplay rounds 1–2; edge-cases round 1 |
| Idempotent events; no double releases under retries | engine idempotency test; `security/authorization` concurrent ticks (6 parallel ticks → exactly one ping) |
| Timeout censored | engine + edge-cases (cap shifted by claim window and pause) |
| Role swap | gameplay rounds 1–4 (A/B/A/B), edge-cases override |
| Distance filters, spike rejection, gaps, simplification | `unit/geo.test.ts`; gameplay recap distances within expected bounds |
| Comparison validity across unequal/censored/aborted/rule-changed rounds | `unit/scoring.test.ts`, edge-cases |
| Real Firebase Auth tokens in emulator; rules | all integration tests use emulator-issued ID tokens; `security/firestore-rules.test.ts` |
| Payload cannot reassign team/role | security "role/team smuggling" |
| Crews of 1–5 phones; a sixth phone is refused; mid-round joiners are spectators (ADR 0013, superseding "exactly two operators") | edge-cases "a crew takes at most five phones"; gameplay join tests; engine "several phones per crew" |
| Raw hider data unreadable by seeker **who is also host** | security suite (host = seeker) + rules suite |
| Photos only post-authorization; EXIF stripped | gameplay (GPS/serial strings removed); security (outsider 404) |
| Late GPS never retro-leaks | pingSelection unit + security "late (offline) uploads" |
| Expired / used invites rejected; direct invites need friendship | gameplay + security |
| Deletions remove documents and objects | security: delete my data, delete night, delete account |
| Nights stored before crews still list, score and delete; delete-my-data redacts their pins | `unit/legacy.test.ts`, `integration/legacy-nights.test.ts` |
| Worker not callable with client token | security worker test (local worker); `security/functions-surface.test.ts` (only `api` public, `tick` invokable only by the backend SA); `unit/functions.tasks.test.ts` (caller check) |
| iOS: server-time clock rendering, cadence filter, encrypted queue + idempotent batch ids, view decoding, deep links | `ManhuntCrewsTests` |
| Live Activity content never carries coordinates, phone ids, names or free text (all phases, both roles, several phones); ≤ 4 KB | `unit/views.privacy.test.ts`; `security/authorization.test.ts` (every push a host-seeker's activity received) |
| Live Activity: app and server map a view to the same content | `unit/liveActivity.contract.test.ts` writes `shared/fixtures/live-activity.json`; `ManhuntCrewsTests/LiveActivityTests.swift` checks the Swift mapping against it |
| Live Activity pushes: push-to-start on the other phones, updates from each phone's own view with its clock offset, alerts in place of duplicate pushes, idempotent ticks, dead tokens dropped, end with a 15-min dismissal, revoke ends all | `integration/liveActivities.test.ts`; payload shape vs. Apple's docs and the notifier skip in `unit/liveActivity.push.test.ts` |

## Found in production (2026-10-22)

Nights recorded before crews v2 were never migrated. The current code crashed on them. For an account with such a night, `GET /v1/sessions` returned 500, because the old crews have `operatorUid` instead of `operatorUids`. So did person stats, because the old rounds have no `operatorsByTeam`. Night analytics, export and delete-my-data broke on the same nights. Delete-my-data would also have left the hider's pins unredacted in `pings/p{index}`: those pins have no `sourceUid`, and the check required `null`. Their stored views (schema 1) came back to a night's detail screen in a shape the app can't decode. Old documents are now upgraded as they're read (`domain/legacy.ts`), a schema-1 stored view is replaced by a freshly rendered one, and the pin check treats a missing source like `null`. `integration/legacy-nights.test.ts` fails without these changes: all four cases, with the same 500 the app showed as "Internal error". On the app side, a person's stats screen swallowed the error and showed a spinner forever. It now shows the error with Try Again.

## Found playing a full night (2026-10-22, 5 rounds, 7 phones, crews reshuffled 4 times; reviewed 2026-10-23)

Read from the production records and logs, then replayed in the emulator:
* **People credited to the wrong crew.** Joining accounts named differently from the names the organizer typed were listed twice, and moved phones left their owners' names on the old crew, so person stats credited one player with hiding twice for a crew he sought for, and a crew made of moved phones hid with no names. Fixed by ADR 0018; `integration/night-replay.test.ts` replays the joins and moves, and `unit/crews.test.ts` covers matching.
* **Round ends took 2–9 s.** The catch decision and each phone's final upload recomputed the whole recap at once. Now one computation runs under a lease and the others return; superseded track archives are removed; the recap timeline starts at the round.
* **Every chase-start ping released 3–4 s late** (cold start of `tick`). Wake-ups are now dispatched 8 s early and wait for the deadline.
* **Every Live Activity push failed** with `messaging/third-party-auth-error` (APNs rejected the project's credentials): 88 failures, retried on every change. Now paused and logged once with the fix; regular push failures, previously silent, are logged by code. The APNs key itself still needs checking in the Firebase console.
* **A hiding phone tracked nothing for 8½ minutes** (left in a pocket since the last round), another never started. The watchdog now pushes "your phone isn't tracking", and tapping a notification opens the night.
* **The ready mark was undone 10 times**, mostly by a second phone on an already-ready crew: tapping its crew's "Ready" button cleared the mark. Undoing now asks first.
* **History showed "Round 4 · hid"** for a crew removed later. Briefs now keep crew names.
* **A retried upload racing its first attempt** returned 500 (`ALREADY_EXISTS`); found while replaying the night, now counted as duplicates.

Checked on the iPhone 17 simulator against a copy of the night in the emulator (test logins with the players' ids, no production writes): History, round recaps, the join flow's name suggestion, the undo-ready confirmation and the crew editor moving a phone's owner. The tracking nudge and the round-end path were exercised with a live round on the local stack. Not checked: real APNs delivery, a physical device, and two simulators at once.

## People make the crew (ADR 0019), checked in the app (2026-10-23, iPhone 17 simulator / iOS 27, local stack, emulator test accounts)

| Check | Result |
|---|---|
| Create a night: people per crew, someone under Sitting Out, the creator's row can't sit out, "Hides first" lists crews by their people | ✅ |
| Lobby: crews as people with phone badges, Sitting Out row, "Morgan hides / Sam seeks" with one person, "Morgan & Jules hide" with two | ✅ |
| A phone joining as someone sitting out lands on a crew, live in the organizer's lobby | ✅ (joins sent through the API as two other test accounts) |
| Crews & Rules: drag a person with a phone to the other crew; the person menu (Move to, Sit Out, Take Their Phone Out, Remove); Save; the phones follow their owners | ✅ drag and drop works in the simulator with a long press |
| A phone sitting out: no crew, listed under Sitting Out, Ready refused | ✅ (through the API) |
| Two rounds with a reshuffle and a rules change between them: recap "Jules & Taylor hid · Morgan sought", "Morgan hides next"; Night Summary "Crews Changed During the Night", one matchup per round, People tallies, chart coloured by the hiding crew, "Taylor → Orange crew · Sam Lee out · Pings every 10 min → 5 min" under round 2; History "Round 1 · Morgan & Taylor hid" | ✅ rounds played through the API, read in the app |
| On a physical iPhone, the Live Activity's "Blue crew" label | ⏳ |

## Found by the first real deploy (2026-10-20)

Production Firestore rejected two composite indexes that the emulator accepts: `sessions(memberUids CONTAINS, participantPersonIds CONTAINS)` and `groups(memberUids CONTAINS, personIds CONTAINS)`. The queries behind them in `SocialService.canSeePerson` used two `array-contains` filters, which production allows only once per query. The groups query would have returned 500 when viewing a person someone else added, and the sessions query's error was swallowed, hiding people from shared nights. Both now use one `array-contains` and filter the other array in memory, the invalid indexes are gone, and `unit/firestore.indexes.test.ts` fails on either pattern.

## Two-simulator E2E

`scripts/e2e-two-simulators.sh` boots two simulators, starts simulated GPS routes (hider walking 1.6 m/s, seeker driving 12 m/s), and runs `TwoPhoneE2ETests.testHost` and `.testSeeker` **concurrently**. Rules: 60 s head start, 60 s pings (DEBUG `-uiTestShortRules`). The hider app is sent to the background (home button) for the entire chase to exercise background location and uploads.

**Crews v2 (2026-10-21): ✅ PASS, 3 consecutive runs** (`e2e-20261021-090055`, `-091041`, `-091842`) on iPhone 16 Pro Max + iPhone 16e (iOS 18.5). The flow:
1. The host's phone shows the night code; the seeker joins with it and picks Crew B.
2. One "I agree" consent each, then both Ready and start.
3. Pings #0 and #1 arrive (GPS samples 13–17 s old). The seeker's one-tap **Directions** opens Apple Maps.
4. Photo catch, confirmed on the hider's backgrounded phone: "Caught after 1:10".
5. **Next: Round 2** defaults to the crew that has hidden least, so Crew B hides; ping #0 arrives (14 s old) and the round ends "Caught after 0:07" on both phones.

Fixes from these runs:
* Seekers no longer see "Hiders: tracking stopped" before the hider phone's first in-round upload; the crew status reads `STARTING`.
* The "N unsent" chip shows only while uploads fail.
* Local deadline nudges don't pop a banner over the open app.
* The head-start line appears once.

The script now builds with `MH_DEV_HOST=127.0.0.1`, so a LAN host in `Local.xcconfig` (for a physical phone) can't break it.

**v0.2 redesign (2026-10-18): ✅ PASS** — run `e2e-20261018-175622` on iPhone 16 Pro Max + iPhone 16e (iOS 18.5, so the non-glass fallback path) plays rounds 1 and 2 with the redesigned UI: pings #0/#1 at 17 s/14 s sample age, "Caught after 1:07"; round 2 roles swapped, ping #0 at 14 s, "Caught after 0:07" on both phones. The two earlier runs that day failed: one on the stale-round view bug (fixed in the server), one on a single dropped toolbar tap under heavy machine load. The test now retries that tap only while the sheet is still idle. Test changes for the redesign: phase text is matched case-insensitively, and the scroll helper accepts buttons pinned in a bottom action bar.

**v0.1 result: ✅ PASS, 3 consecutive runs.** Latest run `e2e-20261018-031653` plays **round 1 and round 2 with the role swap** (host taps "Set up round 2", both Ready, host starts; the other phone now hides with its app backgrounded; ping #0 sample age 39 s; catch confirmed). First run `e2e-20261018-030004`, host iPhone 16 Pro / seeker iPhone 16 (iOS 18.5): night created → joined by code → disclosure accepted → both Ready → host Start → hider app sent to background for the whole chase → ping #0 at chase start (GPS sample age 17 s) → ping #1 one interval later (13 s) → seeker photo catch accepted by the server → hider confirmed → both phones show "Caught after 1:07".

Notes:
* The iOS 27 simulator runtime proved unreliable for two concurrent UI-test sessions (XCTest automation stalls, "failed to acquire background assertion"); the passing runs use the iOS 18.5 runtime (the app's deployment target is iOS 18).
* Simulators have no usable camera, so the DEBUG-only synthetic photo is used there; the real camera path (UIImagePickerController) needs a device.

Bugs this E2E found and fixed (all covered by tests now): iOS omitted nil health fields → API 400 on every Ready (schema now accepts omitted nullables); stale Firebase session stranded the app on an error screen (now signs out); uploader dropped queued GPS on validation errors (now keeps them); Firestore watch stream silently dead after a peer reset (REST reconciliation + listener restart, ADR 0010); consent switches untappable near the home indicator (accessible checkbox rows).

## Design QA (v0.2 redesign, 2026-10-18)

Verified on the real app against the local stack (`backend/scripts/ui-fixture.ts` sets each game state), iPhone 18 Pro simulator on iOS 27 (Liquid Glass) unless noted.

| Check | Result |
|---|---|
| Sign in, Play, History, People, Friends tabs, Account & Settings sheet | ✅ light + dark |
| Lobby (consent pending → accepted → Ready/Start bar), tracking disclosure sheet | ✅ light + dark |
| Game: seeker chase (HUD, banners, chips, map controls below HUD, pins), safety pause overlay | ✅ light + dark |
| Photo catch (simulator photo → submit → failure/retry state), hider confirm sheet | ✅ dark |
| Round recap (static map preview + full-screen map, distances, pings), night summary + chart | ✅ light + dark |
| Dynamic Type at Accessibility Extra Large (Play, History, night detail, summary) | ✅ rows grow, headers stack, labels wrap, nothing truncated |
| iOS 18.5 fallback (materials instead of glass) | ✅ sign-in screenshot plus the full two-simulator E2E (rounds 1–2) on iOS 18.5 |
| Nights stored before crews (2026-10-22, iPhone 17 simulator, iOS 27): three `ui-fixture` nights rewritten into the pre-crews shape in the emulator | ✅ History lists them; night detail shows crews and rounds; scorecard, round recap with map, and a person's crew stats load |
| Color contrast | ✅ computed: every text token ≥ 4.5:1 on its background in light and dark; white labels on tints ≥ 3:1 (`docs/design-system.md`) |
| Not covered | iPad/sidebar layout, Reduce Transparency and Increase Contrast screenshots (system-handled for glass/materials; tokens have high-contrast variants), VoiceOver walk-through on device |

Found and fixed during QA:
- Typing in History search reported the cancelled previous request as "No connection to the game server" (and a pending alert could block navigation). The same issue was fixed in the recap loader.
- An interactive map inside the scrolling recap captured swipes, so the recap now shows a static preview with a full-screen interactive map.
- Map controls sat under the status bar, so they are now placed via `mapScope` below the HUD.
- Under JDK 25 the Storage emulator's rules runtime crashed the Firebase CLI on the first photo upload, so `scripts/emulator-start.sh` now prefers JDK 21.
- **Server bug (pre-existing), found by the two-simulator E2E:** a stale worker wake-up for a finished round (round 1's 120 s catch-confirmation window) re-rendered every phone's stored view with that old round. Both phones briefly showed the round-1 recap over the round-2 lobby, and the host's Start tap was lost. `roundTx` now renders views from the session's current round. A regression check in `integration/edge-cases.test.ts` fails on the old code and passes on the new.

## Physical two-iPhone acceptance matrix (spec §15.2) — ⏳ not yet run

Simulators cannot validate real GPS reliability, suspension, signal loss or Low Power Mode. These require two iPhones (free Personal Team is enough) and the outdoor protocol below.

| Scenario | Expected | Status |
|---|---|---|
| A hides, B seeks, both awake | First reveal at head-start end, then intervals | 🟡 simulator E2E; ⏳ device |
| Hider locked/pocketed 30+ min | Background updates continue when iOS permits; gaps flagged | 🟡 (simulator background) ⏳ |
| Seeker locked/reopened | Phase + released pins reconcile | ⏳ (reconnect path implemented: scene-active refetch + listener) |
| Crews move with operators | Route/distance reflect operator path with quality flags | 🟡 simulated routes ⏳ |
| Seekers cannot access hider position | Network/API/rules prove only released pins | ✅ automated (API + rules) |
| Ping history 1 → 3 before next round | Seeker sees configured count | ✅ (setup edit + views) ⏳ device |
| Photo capture + confirm | Clock = accepted submission time | ✅ emulator; 🟡 simulator (synthetic photo) ⏳ real camera |
| Photo rejected | Timer/pings resume, no pending-interval leak | ✅ |
| Both lose connectivity briefly | Offline queue uploads later; no retro reveal; status clear | ✅ server side; ⏳ device |
| Hider denies Precise Location | Start warns; coarse fix never released (accuracy gate) | ✅ server; ⏳ device |
| Force-quit hider app | Honest "Tracking stopped/No signal"; documented OS limit | ⏳ |
| Capture upload fails | No claim; timer runs; retry with encrypted local copy | 🟡 code path; ⏳ |
| Open night: any crew hides next, phones move between rounds, no round count | Phones keep or change crews; roles follow the hiding crew | ✅ emulator + real-time E2E |
| Hider phone offline across a ping | Ping waits; current position released on reconnect, labelled late | ✅ emulator + real-time E2E; ⏳ device |
| Live Activity on a locked phone (push build) | Starts on every playing phone (push-to-start on the ones that didn't start); timers run on their own; chase/ping/claim alerts light the screen once (no duplicate notification); ends with the result, gone 15 min later; Smart Stack and CarPlay show the `.small` layout; never a location | ✅ server (emulator, recorded pushes); ⏳ device: needs the paid program, the APNs key in FCM, and the widgets profile |
| Live Activity without push (Personal Team) | Starts in the foreground, updates while the app tracks in the background, local nudges remain | ⏳ simulator/device |
| New night with mixed roster | Stable personId history shows composition change | ✅ (scoring unit + people API) |
| One timeout/abort | Censored/incomparable labels, no false winner | ✅ |
| Phones request route deletion | That phone's routes/objects/pins invalidated; crew route recomputed from its other phones | ✅ |
| Finalized round inspected by both | Combined routes, photos, distances | ✅ emulator |

### Outdoor protocol (to run)
1. Two iPhones on cellular, both signed in, with a build pointed at a reachable stack: `scripts/dev.sh` on the same Wi-Fi (it already listens on all interfaces), a deployed dev backend, or a TestFlight build against prod.
2. Rules: 10 min head start, 10 min pings (or 2/2 for a quick run). Hider walks ≥ head start + 2 intervals with the phone locked in a pocket; seeker rides as a **passenger**.
3. Repeat with: screen locked, app backgrounded, airplane mode for 2 min mid-chase, Low Power Mode on.
4. Record: ping sample ages (recap "Pings" list), coverage %, distance vs. a reference (e.g., Apple Fitness walk), screenshots of both phones. Keep raw exports inside `test-artifacts/private/` (git-ignored).
