# Agent instructions — Manhunt Crews

Product/technical source of truth: `docs/product-spec.md` (the original handoff). Deviations are recorded as ADRs in `docs/adr/`.

## Non-negotiables
1. **Secrecy invariant.** During HEAD_START / CHASE / CAPTURE_PENDING / PAUSED the seeking operator may receive only *released* hider pings. Any new client-readable data must be produced by `backend/src/domain/views.ts`; add a case to `tests/unit/views.privacy.test.ts` and `tests/security/*` for every new field or endpoint. Never add raw samples, latest hider position or hider routes to views, API responses, notifications, logs, analytics or exports.
2. **Server-authoritative time.** All transitions and deadlines derive from persisted `roundStartAt`, `chaseStartAt`, `pauses[]` (see `clock.ts`). Never use a device clock or push delivery for correctness.
3. **Idempotency.** State changes run in Firestore transactions; the worker tick must stay idempotent; pings are unique per index (`tx.create`).
4. **Crew attribution.** Never present a team outcome as an individual's time or distance. No single-round winner fields.
5. **No secrets in the repo or the app binary.** No service-account keys; ADC on Cloud Run; `GoogleService-Info.plist`, `.p8`, tfvars and `Local.xcconfig` are git-ignored.
6. **No paid deployments or account changes without the user's explicit approval.**

## Workflow
* Backend: `cd backend && npm run typecheck && npm run test:unit && npm run test:integration` (needs Java for emulators).
* iOS: `xcodebuild test … -only-testing:ManhuntCrewsTests` on a simulator; full two-phone flow with `scripts/e2e-two-simulators.sh` while `scripts/dev.sh` runs.
* Keep `shared/openapi.yaml` in sync — the contract test fails on undocumented or stale routes.
* Request bodies use strict zod schemas in `backend/src/schemas/api.ts`; mirror changes in `ios/ManhuntCrews/Services/API/Endpoints.swift` and `Models/`.
