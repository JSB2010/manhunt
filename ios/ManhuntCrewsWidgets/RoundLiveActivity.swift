import ActivityKit
import SwiftUI
import WidgetKit

/// The round on the Lock Screen, in the Dynamic Island, StandBy, the Apple Watch Smart Stack,
/// CarPlay and the Mac menu bar (HIG › Live Activities). It answers the game screen's three
/// questions — what phase, how long, when is the next ping — and never shows a location.
/// Every timer is a system timer (`Text(timerInterval:)`), so it keeps running between
/// updates without the app. Tapping anywhere opens the night's game screen. No buttons:
/// seekers watch it from a car (CarPlay disables them anyway), and a catch is reviewed on
/// the photo, in the app.
struct RoundLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RoundActivityAttributes.self) { context in
            RoundActivityLockScreen(context: context)
                .widgetURL(RoundActivityText.url(context.attributes))
        } dynamicIsland: { context in
            let s = context.state
            let a = context.attributes
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(RoundActivityText.roleLabel(a.role))
                    } icon: {
                        Image(systemName: RoundActivityText.symbol(s, role: a.role)).foregroundStyle(WidgetTheme.tint(s, crew: a.crew))
                    }
                    .font(.headline)
                    .lineLimit(1)
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("Round \(a.roundIndex)")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(RoundActivityText.shortTitle(s))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(WidgetTheme.tint(s, crew: a.crew))
                            Spacer(minLength: 8)
                            BigClock(state: s)
                                .font(.system(size: 40, weight: .bold, design: .rounded))
                        }
                        StatusLine(state: s, attributes: a, stale: context.isStale)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                CompactLeading(state: s, attributes: a)
            } compactTrailing: {
                CompactTrailing(state: s, attributes: a)
            } minimal: {
                MinimalView(state: s, attributes: a)
            }
            .keylineTint(WidgetTheme.crew(a.crew))
            .widgetURL(RoundActivityText.url(a))
        }
        // Custom layouts for the Smart Stack and CarPlay (.small) and StandBy (.medium).
        .supplementalActivityFamilies([.small, .medium])
    }
}

// MARK: - Theme

/// Colour = crew, never role (docs/design-system.md). Warning and danger only with a symbol.
enum WidgetTheme {
    static func crew(_ key: String) -> Color {
        switch key {
        case "B": Color("CrewB")
        case "C": Color("CrewC")
        default: Color("CrewA")
        }
    }

    static func tint(_ s: RoundActivityAttributes.ContentState, crew key: String) -> Color {
        guard s.phase == .PAUSED else { return crew(key) }
        return s.safetyPause ? Color("Danger") : Color("Warning")
    }
}

// MARK: - Clocks

/// A range for a system timer that never traps when the target is already past.
private func until(_ end: Date) -> ClosedRange<Date> { min(Date.now, end)...end }

/// The countdown that matters right now: chase start, the next ping, or the claim deadline.
private func countdown(_ s: RoundActivityAttributes.ContentState) -> Date? {
    switch s.phase {
    case .HEAD_START: s.headStartEnd
    case .CHASE: s.pingWaiting ? nil : s.nextPing
    case .CAPTURE_PENDING: s.claimExpiry
    case .PAUSED, .ENDED: nil
    }
}

/// The round's big clock: head start left, or chase time (running or frozen).
private struct BigClock: View {
    let state: RoundActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.phase == .HEAD_START, let end = state.headStartEnd {
                Text(timerInterval: until(end), countsDown: true)
            } else if state.phase == .PAUSED, state.clockPhase == .HEAD_START {
                Text(RoundActivityText.clock(state.headStartRemaining ?? 0))
            } else if let start = state.chaseStart {
                Text(timerInterval: start...start.addingTimeInterval(24 * 3600), countsDown: false)
            } else {
                Text(RoundActivityText.clock(state.chaseElapsed ?? 0))
            }
        }
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .multilineTextAlignment(.trailing)
    }
}

/// One line under the clock: the next ping (or claim deadline) as a live countdown,
/// otherwise the phase's plain words. Stale content says so instead of guessing.
private struct StatusLine: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes
    let stale: Bool

    var body: some View {
        Group {
            if stale && state.phase != .ENDED {
                Label("Open the app for the latest", systemImage: "arrow.clockwise")
            } else if state.phase == .CHASE, !state.pingWaiting, let next = state.nextPing {
                Text("Ping \(state.nextPingIndex) in \(Text(timerInterval: until(next), countsDown: true))")
            } else if state.phase == .CAPTURE_PENDING, attributes.role == .HIDING, let exp = state.claimExpiry {
                Text("Review the catch photo · \(Text(timerInterval: until(exp), countsDown: true)) left")
            } else {
                Text(RoundActivityText.detail(state, role: attributes.role, crew: attributes.crew))
            }
        }
        .lineLimit(2)
        .monospacedDigit()
    }
}

// MARK: - Lock Screen, StandBy, Smart Stack, CarPlay

struct RoundActivityLockScreen: View {
    let context: ActivityViewContext<RoundActivityAttributes>
    @Environment(\.activityFamily) private var family
    @Environment(\.isActivityFullscreen) private var fullscreen

    var body: some View {
        if family == .small {
            SmallLayout(state: context.state, attributes: context.attributes, stale: context.isStale)
        } else {
            LockScreenLayout(state: context.state, attributes: context.attributes, stale: context.isStale, fullscreen: fullscreen)
        }
    }
}

/// Lock Screen banner (and StandBy, scaled up): the game screen's phase banner, in brief.
private struct LockScreenLayout: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes
    let stale: Bool
    let fullscreen: Bool

    var body: some View {
        let tint = WidgetTheme.tint(state, crew: attributes.crew)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: RoundActivityText.symbol(state, role: attributes.role))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(RoundActivityText.title(state, role: attributes.role))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("\(attributes.crewName) · Round \(attributes.roundIndex)")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .font(.subheadline.weight(.semibold))

            HStack(alignment: .firstTextBaseline) {
                BigClock(state: state)
                    .font(.system(size: fullscreen ? 76 : 46, weight: .bold, design: .rounded))
                Spacer(minLength: 8)
                Text(RoundActivityText.clockCaption(state))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            StatusLine(state: state, attributes: attributes, stale: stale)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        }
        // HIG › Live Activities: 14 pt is the standard Lock Screen margin.
        .padding(14)
        .accessibilityElement(children: .combine)
    }
}

/// Smart Stack on Apple Watch and the CarPlay Dashboard: phase, clock, one line. No controls.
private struct SmallLayout: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: RoundActivityText.symbol(state, role: attributes.role))
                    .foregroundStyle(WidgetTheme.tint(state, crew: attributes.crew))
                    .accessibilityHidden(true)
                Text(RoundActivityText.shortTitle(state))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text(RoundActivityText.roleLabel(attributes.role))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            BigClock(state: state)
                .font(.title2.weight(.bold))
                .fontDesign(.rounded)
            StatusLine(state: state, attributes: attributes, stale: stale)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Dynamic Island

/// Leading: the role (or phase) symbol in the crew colour, snug against the camera.
private struct CompactLeading: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes

    var body: some View {
        if #available(iOS 27.0, *) {
            LimitedWidthAware(full: symbol, limited: MinimalView(state: state, attributes: attributes))
        } else {
            symbol
        }
    }

    private var symbol: some View {
        Image(systemName: RoundActivityText.symbol(state, role: attributes.role))
            .foregroundStyle(WidgetTheme.tint(state, crew: attributes.crew))
            .accessibilityLabel(RoundActivityText.title(state, role: attributes.role))
    }
}

/// Trailing: the countdown that matters (chase start, next ping, claim deadline), else the frozen clock.
private struct CompactTrailing: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes

    var body: some View {
        if #available(iOS 27.0, *) {
            // Limited width: the leading view carries everything; an empty trailing view is hidden.
            LimitedWidthAware(full: clock, limited: EmptyView())
        } else {
            clock
        }
    }

    private var clock: some View {
        Group {
            if let end = countdown(state) {
                Text(timerInterval: until(end), countsDown: true)
            } else if state.phase == .CHASE && state.pingWaiting {
                Image(systemName: "hourglass").accessibilityLabel("Ping waiting")
            } else {
                BigClock(state: state)
            }
        }
        .font(.body.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(WidgetTheme.tint(state, crew: attributes.crew))
        .frame(maxWidth: 52)
    }
}

/// Minimal (several activities) and limited width: the live countdown when there is one —
/// like the Timer app — inside a 28 pt circle, else the symbol.
private struct MinimalView: View {
    let state: RoundActivityAttributes.ContentState
    let attributes: RoundActivityAttributes

    var body: some View {
        let tint = WidgetTheme.tint(state, crew: attributes.crew)
        Group {
            if let end = countdown(state) {
                Text(timerInterval: until(end), countsDown: true, showsHours: false)
                    .font(.caption2.weight(.bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundStyle(tint)
            } else {
                Image(systemName: RoundActivityText.symbol(state, role: attributes.role))
                    .foregroundStyle(tint)
                    .accessibilityLabel(RoundActivityText.title(state, role: attributes.role))
            }
        }
        .frame(maxWidth: 28, maxHeight: 28)
    }
}

/// Picks the limited-width layout where the Dynamic Island is narrow (landscape, several
/// activities, iPhone Duo) — HIG › Live Activities › Support limited width presentations.
@available(iOS 27.0, *)
private struct LimitedWidthAware<Full: View, Limited: View>: View {
    @Environment(\.isDynamicIslandLimitedInWidth) private var limited
    let full: Full
    let limitedView: Limited

    init(full: Full, limited: Limited) {
        self.full = full
        self.limitedView = limited
    }

    var body: some View {
        if limited { limitedView } else { full }
    }
}
