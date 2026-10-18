# ADR 0009 — Tooling choices

**Status:** accepted

* **Xcode project:** hand-written `project.pbxproj` using Xcode 16+ file-system-synchronized groups (no XcodeGen/Tuist dependency); new Swift files are picked up automatically.
* **Swift language mode 5** with targeted `@MainActor`/actors (Firebase and CoreLocation async sequences are not fully Sendable-annotated); minimum iOS 18.
* **Firebase iOS SDK 12.x** via SPM (Auth, Firestore, Messaging).
* **Backend:** Node 24, TypeScript 5.9, Fastify 5, zod 4 (strict schemas parsed in handlers), firebase-admin 14, vitest 4.
* **Rate limiting:** in-memory per instance (see threat model).
* **Validation:** zod schemas are the request-validation source of truth; `shared/openapi.yaml` is hand-maintained and enforced by a route contract test rather than code generation.
* **DEBUG-only test hooks:** a synthetic "simulator test photo" (simulators have no camera) and a `-uiTestShortRules` launch argument for automated two-simulator runs. Neither exists in Release builds.
