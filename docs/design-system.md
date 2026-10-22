# Design system — Manhunt Crews (iOS)

*2026-10-18. Applies to `ios/ManhuntCrews`. Decision record: [ADR 0011](adr/0011-native-ios-design.md).*

The app follows Apple's Human Interface Guidelines and adopts the iOS 26 design (Liquid Glass) natively, with fallbacks on iOS 18–25. Where sources disagreed, the HIG won.

## Thesis

**One job per screen, and the clock is the signature.** Out of a round, the app gets a night going fast. In a round, it answers three questions at a glance, outdoors, in sunlight or at night: *what phase is it, how long is left, where was the last ping?* The big rounded clock on a glass panel above the map is the element people remember. Everything around it stays quiet.

## Two layers

Apple's model ([HIG › Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)):

| Layer | What's in it | Material |
|---|---|---|
| Content | Lists, forms, the map, photos, charts | System backgrounds and fills (`systemGroupedBackground`, `.fill.tertiary`). Never glass. |
| Functional (floating) | Tab bar, toolbars, the map HUD and banners, game controls, bottom action bars, toasts, controls over photos | Liquid Glass on iOS 26+, standard materials on iOS 18–25 |

Custom glass appears only where controls float over the **map, camera or photos**. Every other screen gets glass from standard system bars, which is free.

| Screen | Custom glass |
|---|---|
| Game | Phase HUD, map banners, ping/health chips, location button, control group (options · Photo Catch · Home), paused card |
| Photo catch | Retake / Submit and status, over the photo |
| Recap | Expand button over the static map preview |
| Lobby, consent, join, hider confirm, profile setup, round recap | Bottom action bar via `safeAreaBar` with the hard scroll-edge effect (no custom background) |
| Everything else | None: system tab bar, toolbars, sheets, search |

## Tokens

All colors are asset-catalog colors with **light, dark and Increase Contrast** variants (`Resources/Assets.xcassets`). Each color has one meaning ([HIG › Color](https://developer.apple.com/design/human-interface-guidelines/color)):

| Token | Meaning | Light | Dark | Contrast (text on its background) |
|---|---|---|---|---|
| `AccentColor` | "Go" actions and OK status | #1B7F3B | #28A653 | 5.1:1 on white · 5.4:1 on #1C1C1E · white label on tint ≥ 3.1:1 |
| `CrewA` | Crew identity | #1565C0 | #3D8EF0 | 5.7:1 · 5.1:1 · white on tint 3.3:1 (dark) |
| `CrewB` | Crew identity | #C2410C | #EE6A30 | 5.2:1 · 5.5:1 · white on tint 3.1:1 (dark) |
| `Warning` | Status (with ⚠ symbol) | #B25000 | #FFB340 | 5.2:1 · 9.5:1 |
| `Danger` | Status (with ⛔ symbol) | #D70015 | #FF6961 | 5.4:1 · 6.0:1 |

Rules:
- **Color = crew, never role.** Hiding and seeking are always a symbol plus a word: `eye.slash.fill` "Hiding", `binoculars.fill` "Seeking". Released pins are drawn in the hiding crew's color. The server's crew hex values are not used on iOS; the app maps crew A/B to adaptive tokens.
- **Status is never color alone.** Every state has a distinct symbol shape (checkmark circle, triangle, octagon, minus circle) and the text stays primary.
- Text sizes come from text styles only. The game clock uses `@ScaledMetric` with rounded design and monospaced digits, so it grows with Dynamic Type.
- Spacing uses system defaults (`padding()`, default stack spacing). Explicit values exist only in the shared components.

## Components (`Shared/DesignSystem.swift`)

| Component | Purpose | iOS 26+ | iOS 18–25 |
|---|---|---|---|
| `glassSurface(in:interactive:)` | Floating panels and chips | `glassEffect(.regular[.interactive])` | `.regularMaterial` |
| `GlassGroup` | Groups nearby glass controls | `GlassEffectContainer` | passthrough |
| `floatingProminentButton()` / `floatingButton()` / `floatingButton(prominent:)` | Floating actions (one prominent per group) | `.glassProminent` / `.glass` | `.borderedProminent` / material capsule |
| `bottomActionBar { }` | Primary action pinned above scrolling content | `safeAreaBar` + `.scrollEdgeEffectStyle(.hard)` | `safeAreaInset` + `.bar` |
| `CloseButton` / `CancelButton` / `ConfirmButton` | Standard toolbar actions | `Button(role: .close/.cancel/.confirm)` | ✕ / "Cancel" / semibold text |
| `ActionLabel` | Full-width button label with spinner | 1 line; wraps to 2 at accessibility sizes | same |
| `StatusBadge`, `StatusRow`, `CrewDot`, `RoleLabel`, `InlineNotice`, `CheckRow`, `FlowLayout`, `ToastView` | Content-layer building blocks | — | — |

Content-layer buttons use the standard `.borderedProminent` / `.bordered` styles with `.controlSize(.large)`, which take on the iOS 26 capsule automatically.

## Navigation

- **Tab bar** (`TabView` + `Tab`, `.sidebarAdaptable`) for top-level sections: **Play · History · Friends · People**. Friends shows a badge for incoming requests. Groups live in People behind a segmented control. Account & Settings opens from the profile button on Play, as in Apple's own apps. Before this, all of these were buried in a list on Home.
- A night in progress is a **full-screen modal flow** (lobby → game → recap) with the standard ✕ to leave. Tracking continues in the background.
- Sheets use the standard ✕/Cancel and a single prominent confirm action. Medium detents where the content is short (invite, phone status, start warnings).

## Game screen (signature)

- **Map** is full-bleed content with `emphasis: .muted` so pins and trails stand out ([HIG › Maps](https://developer.apple.com/design/human-interface-guidelines/maps)). Built-in controls are placed with a `mapScope` below the HUD, so they never sit under the status bar or the glass panels. The Apple Maps logo and legal link stay visible.
- **HUD**: role symbol in my crew color, "Chase · Seeking", "Round 1 of 4", the clock, and next ping / time limit. On a safety pause it switches to a red octagon and shows the reason.
- **Banners** (glass): tracking stopped (with Resume), pause requests (with Confirm), catch outcome, car moving. Each banner has a symbol and an action where one makes sense.
- **Chips**: last ping ("Ping #2 · 41s ago", or why it's unavailable) and a single worst-first health summary that opens **Phone Status** (a medium sheet with the full detail) instead of a strip of six pills.
- **Controls**: circular glass Options (menu) and Home, with the one prominent action between them: Photo Catch for seekers, or a sharing status for hiders.
- **Pins**: diamond shape plus index number and a white outline for contrast; the latest is larger and labeled. Shape and number mean color is never the only signal.

## Live Activity (Lock Screen, Dynamic Island, Smart Stack, CarPlay)

[ADR 0017](adr/0017-live-activities.md). A round on a locked phone answers the same three questions as the game screen. It follows [HIG › Live Activities](https://developer.apple.com/design/human-interface-guidelines/live-activities).

| Presentation | Content |
|---|---|
| Lock Screen (system background, 14 pt margins) | Role symbol in crew colour · "Chase · Seeking" · crew and round; big rounded clock (head start left, or chase time); one status line with the next ping or claim deadline as a live countdown |
| StandBy (`.medium`, `isActivityFullscreen`) | Same layout, larger clock |
| Dynamic Island compact | Leading: role (or phase) symbol in crew colour. Trailing: the countdown that matters (chase start, next ping, claim deadline) |
| Minimal | The countdown, as the Timer app does; the symbol when nothing counts down |
| Limited width (iOS 27) | One 28 pt leading view; empty trailing view, which the system hides |
| Expanded | Role · round; phase and big clock; status line |
| Smart Stack / CarPlay (`.small`) | Phase symbol and word, clock, one line. No controls |

Rules:
- Every timer is a system timer (`Text(timerInterval:)`), so it keeps running between updates. Stale content says "Open the app for the latest".
- Colour is the crew, and the Dynamic Island keyline uses it. Warning and danger appear only with the pause symbols.
- No buttons. Tapping opens the night's game screen.
- Never a location, a roster name or a free-text reason. The Lock Screen is readable by anyone nearby.
- Settings › **Show Rounds on Lock Screen** and game Options › **Hide Live Activity** turn it off. An activity removed from the Lock Screen stays removed for that round.

## Accessibility

- **Dynamic Type**: verified at Accessibility Extra Large. Rows grow, chips wrap (`FlowLayout`), headers stack (`AnyLayout`, `ViewThatFits`), and action labels wrap instead of truncating.
- **VoiceOver**: icon-only buttons have labels (Round Options, Home, Close, Expand). Pins, chips and the clock have spoken labels (`Fmt.spokenDuration`; the clock carries `.updatesFrequently`). Composite rows are combined. Invite codes are spelled out with `.speechSpellsOutCharacters()`.
- **Reduce Transparency / Increase Contrast**: glass and materials adapt automatically. Every token has a high-contrast variant.
- **Reduce Motion**: the pulsing sharing symbol stops, and toast and morph transitions fall back to opacity.
- **Touch targets**: ≥ 44 pt for every floating control.
- **Haptics**: success feedback when a catch is submitted (`sensoryFeedback`).
- **Live Activity**: each presentation is one combined VoiceOver element; icon-only compact and minimal views carry the phase as their label.

## App icon

`AppIcon` keeps the existing artwork and adds **dark** and **tinted** Home Screen variants (artwork on a transparent background, per Apple's spec for those appearances). A fully layered Icon Composer `.icon` is a designer follow-up: Icon Composer is a GUI tool, and its file format isn't documented for hand authoring.

## Sources

Installed skills: `axiom-design`, `design`, `apple-design` (123 HIG pages pulled from developer.apple.com), `liquid-glass`, `swiftui-expert-skill`, `swiftui-liquid-glass`. Apple documentation read for this work: HIG Liquid Glass, Materials, Color, Layout, Accessibility, Typography, Tab bars, Toolbars, Maps, Buttons. Developer docs: [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views), [`safeAreaBar`](https://developer.apple.com/documentation/swiftui/view/safeareabar(edge:alignment:spacing:content:)), [`ButtonRole.close`](https://developer.apple.com/documentation/swiftui/buttonrole/close). Every API signature and availability was checked against the iOS 27 SDK interfaces installed with Xcode 27.
