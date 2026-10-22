# Documentation

| If you want to… | Read |
|---|---|
| Play | [how-to-play.md](how-to-play.md) |
| Run it locally or change the code | [development.md](development.md), then [AGENTS.md](../AGENTS.md) |
| Understand the system | [architecture.md](architecture.md) → [data-model.md](data-model.md) → [api.md](api.md) |
| Know what's protected and why | [permissions-threat-model.md](permissions-threat-model.md), [scoring-and-privacy.md](scoring-and-privacy.md) |
| Deploy the backend | [deployment.md](deployment.md), [../scripts/setup-firebase.md](../scripts/setup-firebase.md) |
| Ship to TestFlight | [release-prod.md](release-prod.md), [apple-distribution.md](apple-distribution.md) |
| See what's tested | [test-matrix.md](test-matrix.md) |
| Work on the UI | [design-system.md](design-system.md) |
| Know why something is the way it is | [adr/README.md](adr/README.md), [product-spec.md](product-spec.md) |
| Look up a term | [glossary.md](glossary.md) |

## All documents

| Document | What it is | Keep in step with |
|---|---|---|
| [how-to-play.md](how-to-play.md) | Player guide | UI labels, rules defaults (`domain/rules.ts`) |
| [development.md](development.md) | Setup, running, tests, recipes for common changes, troubleshooting | `package.json` scripts, `scripts/`, `ios/Config/` |
| [architecture.md](architecture.md) | Components, round lifecycle, data flows, timing, scheduling | `backend/src`, `ios/` structure |
| [data-model.md](data-model.md) | Firestore and Storage layout, view contents, TTLs | `services/repo.ts`, `domain/types.ts`, `domain/views.ts`, `firestore.indexes.json` |
| [api.md](api.md) | REST conventions and the route list | `shared/openapi.yaml`, `api/http.ts` |
| [permissions-threat-model.md](permissions-threat-model.md) | Assets, trust boundaries, controls and the tests that prove them | `tests/security/`, `firestore.rules`, `functions/index.ts` |
| [scoring-and-privacy.md](scoring-and-privacy.md) | Time definitions, scoring, distances, retention, deletion | `clock.ts`, `scoring.ts`, `geo.ts`, `dataService.ts` |
| [deployment.md](deployment.md) | Deploying the backend, runtime config, operations, rollback | `firebase.json`, `scripts/deploy-backend.sh`, `scripts/setup-gcp-project.sh` |
| [release-prod.md](release-prod.md) | Step-by-step production and TestFlight runbook | `scripts/ios-signing.sh`, `scripts/ios-release.sh`, `ios/Config/Prod.xcconfig` |
| [apple-distribution.md](apple-distribution.md) | Signing and device builds: Personal Team, paid program | `ios/Config/`, entitlements, `Info.plist` |
| [test-matrix.md](test-matrix.md) | Suites, latest results, spec coverage, the physical-device checklist | the test suites |
| [design-system.md](design-system.md) | iOS design: layers, tokens, components, Live Activity, accessibility | `Shared/DesignSystem.swift`, asset catalog |
| [glossary.md](glossary.md) | Terms and their names in code | |
| [adr/](adr/README.md) | Architecture decision records | |
| [product-spec.md](product-spec.md) | The original handoff spec (v1.0, 2026-10-17). Historical: where an ADR disagrees, the ADR wins | frozen |

Files named `docs/*.local.md` are git-ignored personal notes (release log, account ids). Never copy their contents into tracked files.
