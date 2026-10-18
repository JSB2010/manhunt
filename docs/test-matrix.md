# Test matrix & results

Legend: ✅ automated and passing · 🟡 partially covered / simulator only · ⏳ requires physical iPhones (not yet run) · — not applicable.

## Automated suites (run on 2026-10-17, macOS, Xcode 27.0, Node 24.18, Firebase CLI 15.28)

| Suite | Command | Result |
|---|---|---|
| Backend unit (domain, privacy invariant, OpenAPI contract, iOS-encoding schemas) | `cd backend && npm run test:unit` | ✅ 55 / 55 |
| Backend integration + security (Auth/Firestore/Storage emulators, rules) | `npm run test:integration` | ✅ 32 / 32 |
| Real-time API E2E (live stack, wall clock, local scheduler → worker) | `npm run e2e:two-operators` | ✅ first ping seen 0.5 s after chase start; ping 1 0.7 s after its deadline; sample age 9 s; 0 unreleased coordinates in seeker view; official time = submission time |
| Backend typecheck | `npm run typecheck` | ✅ |
| iOS unit + listener integration (XCTest, iPhone 16 Pro simulator) | `xcodebuild test … -only-testing:ManhuntCrewsTests` | ✅ 14 / 14 (the listener test runs only when the local stack is up) |
| iOS app build (Debug, simulator) | `xcodebuild build …` | ✅ no warnings in app sources |
| iOS Release build for device (unsigned) | `xcodebuild build -configuration Release -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO` | ✅ |
| Terraform | `terraform validate` (dev, prod) | ✅ |
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
| Worker not callable with client token | security worker test |
| iOS: server-time clock rendering, cadence filter, encrypted queue + idempotent batch ids, view decoding, deep links | `ManhuntCrewsTests` |

## Two-simulator E2E

`scripts/e2e-two-simulators.sh` boots two simulators, starts simulated GPS routes (hider walking 1.6 m/s, seeker driving 12 m/s), and runs `TwoPhoneE2ETests.testHost` and `.testSeeker` **concurrently**. Rules: 60 s head start, 60 s pings (DEBUG `-uiTestShortRules`). The hider app is sent to the background (home button) for the entire chase to exercise background location and uploads.

**Result: ✅ PASS, 3 consecutive runs.** Latest run `e2e-20261018-031653` plays **round 1 and round 2 with the role swap** (host taps "Set up round 2", both Ready, host starts; the other phone now hides with its app backgrounded; ping #0 sample age 39 s; catch confirmed). First run `e2e-20261018-030004`, host iPhone 16 Pro / seeker iPhone 16 (iOS 18.5): night created → joined by code → disclosure accepted → both Ready → host Start → hider app sent to background for the whole chase → ping #0 at chase start (GPS sample age 17 s) → ping #1 one interval later (13 s) → seeker photo catch accepted by the server → hider confirmed → both phones show "Caught after 1:07". Screenshots: `docs/evidence/e2e-seeker-round1.png`, `docs/evidence/e2e-host-round1.png`; transcript: `docs/evidence/e2e-two-simulators.md`.

Notes:
* The iOS 27 simulator runtime proved unreliable for two concurrent UI-test sessions (XCTest automation stalls, "failed to acquire background assertion"); the passing runs use the iOS 18.5 runtime (the app's deployment target is iOS 18).
* Simulators have no usable camera, so the DEBUG-only synthetic photo is used there; the real camera path (UIImagePickerController) needs a device.

Bugs this E2E found and fixed (all covered by tests now): iOS omitted nil health fields → API 400 on every Ready (schema now accepts omitted nullables); stale Firebase session stranded the app on an error screen (now signs out); uploader dropped queued GPS on validation errors (now keeps them); Firestore watch stream silently dead after a peer reset (REST reconciliation + listener restart, ADR 0010); consent switches untappable near the home indicator (accessible checkbox rows).

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
| Rounds 1–4 alternate | Operators keep crews; roles switch | ✅ emulator |
| New night with mixed roster | Stable personId history shows composition change | ✅ (scoring unit + people API) |
| One timeout/abort | Censored/incomparable labels, no false winner | ✅ |
| Both request route deletion | Routes/objects/exports invalidated | ✅ |
| Finalized round inspected by both | Combined routes, photos, distances | ✅ emulator |

### Outdoor protocol (to run)
1. Two iPhones on cellular, both signed in (Debug build pointed at a reachable stack — LAN with `API_HOST=0.0.0.0 scripts/dev.sh` while on the same Wi-Fi, or a deployed dev backend).
2. Rules: 10 min head start, 10 min pings (or 2/2 for a quick run). Hider walks ≥ head start + 2 intervals with the phone locked in a pocket; seeker rides as a **passenger**.
3. Repeat with: screen locked, app backgrounded, airplane mode for 2 min mid-chase, Low Power Mode on.
4. Record: ping sample ages (recap "Pings" list), coverage %, distance vs. a reference (e.g., Apple Fitness walk), screenshots of both phones. Keep raw exports inside `test-artifacts/private/` (git-ignored).
