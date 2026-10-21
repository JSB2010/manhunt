# Test matrix & results

Legend: ✅ automated and passing · 🟡 partially covered / simulator only · ⏳ requires physical iPhones (not yet run) · — not applicable.

## Automated suites (run on 2026-10-17, macOS, Xcode 27.0, Node 24.18, Firebase CLI 15.28)

| Suite | Command | Result |
|---|---|---|
| Backend unit (domain, privacy invariant, OpenAPI contract, iOS-encoding schemas, Cloud Functions adapter + tick handler + task-queue scheduler) | `cd backend && npm run test:unit` | ✅ 115 / 115 (2026-10-21, crews: several phones per crew, three crews, waiting pings, Race/Together credit, shuffler-independent scoring, privacy of source phones) |
| Backend integration + security (Auth/Firestore/Storage emulators, rules, deployed-functions surface) | `npm run test:integration` | ✅ 53 / 53 (2026-10-21: open night with two phones on a crew and a third crew added mid-night; concurrent hider decisions; Race photo restriction; hider outage → waiting ping → current position on reconnect; night code cap/regenerate/brute-force; phone moves/removal; changed-only view writes and 304; gzip bodies incl. a bomb → 413; a joining account whose name is already on the roster isn't listed twice) |
| Real-time crews E2E (live stack, wall clock, 5 phones with Firestore listeners, 3 crews) | `npm run e2e:crews` | ✅ 2026-10-21: ping waited through a 65 s hider outage and released the current position 0.4 s after reconnect (no backlog point); 0 unreleased coordinates in seeker REST views or listener snapshots; Race catch credited to Crew C only, Crew B denied its photo; phone moved and any crew hid next; night ended by a phone. Bandwidth per phone with **1-min pings**: ~4 listener snapshots/min (~16 KB/min) and 3–5 REST calls/min (~1–2.5 KB/min) — vs. a full view rewrite on every batch from every phone before (≈20 snapshots/min per phone with 5 phones) |
| Real-time API E2E (live stack, wall clock, local scheduler → worker) | `npm run e2e:two-operators` | ✅ first ping seen 0.5 s after chase start; ping 1 0.7 s after its deadline; sample age 9 s; 0 unreleased coordinates in seeker view; official time = submission time |
| Real-time API E2E through the **deployable Cloud Functions** (Functions + Cloud Tasks emulators: `api` → task queue → `tick`) | `npm run serve:functions` (alternate ports), then `API_URL=http://127.0.0.1:<port>/demo-manhunt/us-central1/api npm run e2e:two-operators` | ✅ 2026-10-18: first ping seen 1.3 s after chase start; ping 1 0.2 s after its deadline; sample age 7 s; 0 unreleased coordinates in seeker view; photo upload (JPEG through the adapter, metadata stripped), catch, recap, round 2 role swap. The Cloud Tasks emulator ignores `scheduleTime`, so delivery timing here came from `tick`'s early-arrival wait-and-retry (ADR 0012). The first run, before that handling existed, failed at ping 0. |
| Backend typecheck | `npm run typecheck` | ✅ |
| iOS **Prod** configuration (unsigned build) | `xcodebuild build -scheme "ManhuntCrews Prod" -configuration Prod -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO` | ✅ 2026-10-20: bundle `com.example.manhuntcrews`, prod API URL, `GoogleService-Info-Prod.plist` bundled, emulators off, manual signing settings resolved |
| Manual signing helper | `scripts/ios-signing.sh csr` / `install` in a throwaway HOME + keychain with a self-signed stand-in certificate and CMS-signed fake profile | ✅ key/cert pair into an identity; profile checks (bundle, App Store type, push, certificate membership) and `Prod.local.xcconfig` output work. A real Apple certificate and upload are not yet exercised |
| Prod Firebase project | `firebase deploy --only auth,firestore:rules --project your-prod-project` | ✅ 2026-10-20: Email/Password enabled, rules live. Indexes/TTL need Blaze |
| iOS unit + listener integration (XCTest) | `xcodebuild test … -only-testing:ManhuntCrewsTests` | ✅ 47 / 47 (2026-10-21 on iPhone 17 / iOS 27: crews, shuffler, gzip, conditional reload, newest-first recovery, auth resilience, clock through device sleep; the listener test runs only when the local stack is up and the build points at it, e.g. `MH_DEV_HOST=127.0.0.1`) |
| iOS app build (Debug, simulator) | `xcodebuild build …` | ✅ no warnings in app sources |
| iOS Release build for device (unsigned) | `xcodebuild build -configuration Release -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO` | ✅ |
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
| Exactly two UIDs; third operator denied | gameplay join test; engine distinct-operator test |
| Raw hider data unreadable by seeker **who is also host** | security suite (host = seeker) + rules suite |
| Photos only post-authorization; EXIF stripped | gameplay (GPS/serial strings removed); security (outsider 404) |
| Late GPS never retro-leaks | pingSelection unit + security "late (offline) uploads" |
| Expired / used invites rejected; direct invites need friendship | gameplay + security |
| Deletions remove documents and objects | security: delete my data, delete night, delete account |
| Worker not callable with client token | security worker test (local worker); `security/functions-surface.test.ts` (only `api` public, `tick` invokable only by the backend SA); `unit/functions.tasks.test.ts` (caller check) |
| iOS: server-time clock rendering, cadence filter, encrypted queue + idempotent batch ids, view decoding, deep links | `ManhuntCrewsTests` |

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

The script now builds with `MH_DEV_HOST=127.0.0.1`, so a LAN host in `Local.xcconfig` (for a physical phone) can't break it. Screens: `docs/evidence/design/e2e-crews-v2.jpg`.

**v0.2 redesign (2026-10-18): ✅ PASS** — run `e2e-20261018-175622` on iPhone 16 Pro Max + iPhone 16e (iOS 18.5, so the non-glass fallback path) plays rounds 1 and 2 with the redesigned UI: pings #0/#1 at 17 s/14 s sample age, "Caught after 1:07"; round 2 roles swapped, ping #0 at 14 s, "Caught after 0:07" on both phones (`docs/evidence/design/e2e-ios18-fallback.jpg`). The two earlier runs that day failed: one on the stale-round view bug (fixed in the server), one on a single dropped toolbar tap under heavy machine load. The test now retries that tap only while the sheet is still idle. Test changes for the redesign: phase text is matched case-insensitively, and the scroll helper accepts buttons pinned in a bottom action bar.

**v0.1 result: ✅ PASS, 3 consecutive runs.** Latest run `e2e-20261018-031653` plays **round 1 and round 2 with the role swap** (host taps "Set up round 2", both Ready, host starts; the other phone now hides with its app backgrounded; ping #0 sample age 39 s; catch confirmed). First run `e2e-20261018-030004`, host iPhone 16 Pro / seeker iPhone 16 (iOS 18.5): night created → joined by code → disclosure accepted → both Ready → host Start → hider app sent to background for the whole chase → ping #0 at chase start (GPS sample age 17 s) → ping #1 one interval later (13 s) → seeker photo catch accepted by the server → hider confirmed → both phones show "Caught after 1:07". Screenshots: `docs/evidence/e2e-seeker-round1.png`, `docs/evidence/e2e-host-round1.png`; transcript: `docs/evidence/e2e-two-simulators.md`.

Notes:
* The iOS 27 simulator runtime proved unreliable for two concurrent UI-test sessions (XCTest automation stalls, "failed to acquire background assertion"); the passing runs use the iOS 18.5 runtime (the app's deployment target is iOS 18).
* Simulators have no usable camera, so the DEBUG-only synthetic photo is used there; the real camera path (UIImagePickerController) needs a device.

Bugs this E2E found and fixed (all covered by tests now): iOS omitted nil health fields → API 400 on every Ready (schema now accepts omitted nullables); stale Firebase session stranded the app on an error screen (now signs out); uploader dropped queued GPS on validation errors (now keeps them); Firestore watch stream silently dead after a peer reset (REST reconciliation + listener restart, ADR 0010); consent switches untappable near the home indicator (accessible checkbox rows).

## Design QA (v0.2 redesign, 2026-10-18)

Verified on the real app against the local stack (`backend/scripts/ui-fixture.ts` sets each game state), iPhone 18 Pro simulator on iOS 27 (Liquid Glass) unless noted. Screenshots: `docs/evidence/design/`.

| Check | Result |
|---|---|
| Sign in, Play, History, People, Friends tabs, Account & Settings sheet | ✅ light + dark |
| Lobby (consent pending → accepted → Ready/Start bar), tracking disclosure sheet | ✅ light + dark |
| Game: seeker chase (HUD, banners, chips, map controls below HUD, pins), safety pause overlay | ✅ light + dark |
| Photo catch (simulator photo → submit → failure/retry state), hider confirm sheet | ✅ dark |
| Round recap (static map preview + full-screen map, distances, pings), night summary + chart | ✅ light + dark |
| Dynamic Type at Accessibility Extra Large (Play, History, night detail, summary) | ✅ rows grow, headers stack, labels wrap, nothing truncated |
| iOS 18.5 fallback (materials instead of glass) | ✅ sign-in screenshot plus the full two-simulator E2E (rounds 1–2) on iOS 18.5 |
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
| New night with mixed roster | Stable personId history shows composition change | ✅ (scoring unit + people API) |
| One timeout/abort | Censored/incomparable labels, no false winner | ✅ |
| Phones request route deletion | That phone's routes/objects/pins invalidated; crew route recomputed from its other phones | ✅ |
| Finalized round inspected by both | Combined routes, photos, distances | ✅ emulator |

### Outdoor protocol (to run)
1. Two iPhones on cellular, both signed in (Debug build pointed at a reachable stack — LAN with `API_HOST=0.0.0.0 scripts/dev.sh` while on the same Wi-Fi, or a deployed dev backend).
2. Rules: 10 min head start, 10 min pings (or 2/2 for a quick run). Hider walks ≥ head start + 2 intervals with the phone locked in a pocket; seeker rides as a **passenger**.
3. Repeat with: screen locked, app backgrounded, airplane mode for 2 min mid-chase, Low Power Mode on.
4. Record: ping sample ages (recap "Pings" list), coverage %, distance vs. a reference (e.g., Apple Fitness walk), screenshots of both phones. Keep raw exports inside `test-artifacts/private/` (git-ignored).
