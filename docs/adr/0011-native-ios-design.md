# ADR 0011 — Native iOS 26 design: Liquid Glass functional layer, tab navigation, color = crew

**Status:** accepted · **Spec:** §10 (SwiftUI, outdoors-readable, dark/light, large clocks, high-contrast overlays, obvious phase labels, strong warnings, large touch targets), §10 accessibility (Dynamic Type, VoiceOver, colorblind-safe pins, reduced motion), §6.1 (stable crew colors on the recap map)

**Context.** v0.1 was functional but drifted from Apple's conventions:
- Five top-level destinations were buried in a list on Home.
- Floating panels were hand-rolled with `ultraThinMaterial` and colored strokes.
- Green meant both "tap here" and "OK", while blue and orange meant both crew (server default colors) and role. A blue crew could therefore wear an orange "SEEKING" pill, and pins were always blue even when the orange crew was hiding.
- Text-labeled "Close" buttons, all-caps labels and pill strips truncated at normal text sizes. The yellow "PASSENGER ONLY" label was about 1.5:1 contrast on light material.

The project builds with the iOS 27 SDK, so iOS 26+ users get the new design whether or not the app opts out (`UIDesignRequiresCompatibility` is ignored on OS 27 for 27-SDK builds). The deployment target stays iOS 18.

**Decision.**
1. **Two layers.** Content uses system backgrounds and fills. Custom Liquid Glass is used only for controls floating over the map, camera and photos, plus bottom action bars (`safeAreaBar` with the hard scroll-edge effect). Every glass API is behind `#available(iOS 26, *)` with a standard-material fallback (`Shared/DesignSystem.swift`).
2. **Tab bar** (Play · History · Friends · People, `.sidebarAdaptable`), with Account & Settings behind the Play tab's profile button. A night in progress stays a full-screen modal flow.
3. **Color = crew.** Crew A/B map to adaptive asset colors (light, dark and Increase Contrast). The server's crew hex values are no longer used on iOS. Role is always a symbol plus a word. Accent green means "go" and OK. Warning and danger colors always come with a symbol.
4. **Standard controls.** ✕ Close/Cancel and a single prominent confirm action (`ButtonRole.close/.cancel/.confirm` on iOS 26), title-case labels, native lists and forms (`LabeledContent`, `ContentUnavailableView`, matching swipe and context-menu actions).
5. **Game screen.** Muted map, glass phase HUD with a Dynamic Type clock, map controls placed via `mapScope` below the HUD, a worst-first health chip that opens a Phone Status sheet, and diamond-plus-index pins in the hiding crew's color.
6. **App icon.** Dark and tinted appearance variants added. The layered Icon Composer icon is deferred to a designer.

**Consequences.**
- On iOS 26+ the app looks and behaves like a current system app; iOS 18–25 gets the same layout with materials.
- Every text color meets WCAG AA (≥ 4.5:1), and white labels on tints are ≥ 3:1 (bold) in both appearances (`docs/design-system.md`).
- UI tests now match phase text case-insensitively ("Chase · Seeking" instead of "CHASE · SEEKING"). All accessibility identifiers are unchanged.
- No privacy surface changed: the map still draws only this phone's trail and released pins, and opponent health stays coarse.
