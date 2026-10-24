import SwiftUI

// Content-layer building blocks for the recap and the night (docs/design-system.md › Stats).
// One number per tile, with what it means underneath; system fills, never glass.

/// A number that matters, big, with its label and a line of context. One VoiceOver element.
struct StatTile: View {
    let label: String
    let value: String
    var detail: String?
    var symbol: String?
    /// symbol colour (a crew's, usually)
    var tint: Color = .secondary
    /// a highlight this number set ("Most ground on foot so far")
    var badge: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let symbol {
                    Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true)
                }
                Text(label)
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.semibold))
            Text(value)
                .font(.title2.weight(.bold))
                .fontDesign(.rounded)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let badge { HighlightBadge(text: badge) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Two tiles per row; one per row at accessibility text sizes so numbers never shrink to fit.
struct StatGrid<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ViewBuilder var content: Content

    var body: some View {
        let columns = typeSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 10) { content }
    }
}

/// "★ Longest hide so far": a highlight a round or number set.
struct HighlightBadge: View {
    let text: String
    var symbol = "star.fill"
    var tint: Color = .yellow

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .labelStyle(.titleAndIcon)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.fill.secondary, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// One of the night's highlights: what, how much, which crews, which round.
struct HighlightCard: View {
    let highlight: NightHighlight
    let units: String
    /// shows a chevron: the card opens its round
    var tappable = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Label {
                    Text(StatsText.title(highlight.kind))
                } icon: {
                    Image(systemName: StatsText.symbol(highlight.kind)).foregroundStyle(highlight.teams.first.map(Theme.crew) ?? .accentColor)
                }
                Spacer(minLength: 4)
                if tappable { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true) }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            Text(StatsText.value(highlight, units: units))
                .font(.title2.weight(.bold))
                .fontDesign(.rounded)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                ForEach(highlight.teams, id: \.self) { CrewDot(key: $0) }
                Text(highlight.names.formatted(.list(type: .and)))
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
            }
            Text("Round \(highlight.roundIndex)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(StatsText.title(highlight.kind)): \(StatsText.sentence(highlight, units: units))")
    }
}

/// A round in a list: who hid, the outcome, and a bar as long as its chase time (relative to the
/// night's longest), so the night's shape shows without a separate chart.
struct RoundBarRow: View {
    let round: RoundResult
    /// the night's longest chase time (the full bar)
    let longest: Int
    var highlighted = false
    var note: String?

    private var aborted: Bool { round.outcome == "ABORTED" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Round \(round.roundIndex)").font(.headline)
                if highlighted {
                    Text("This round")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(.fill.secondary, in: Capsule())
                }
                Spacer(minLength: 8)
                Label {
                    Text(Fmt.outcome(round.outcome, seconds: round.observedChaseSeconds)).monospacedDigit()
                } icon: {
                    Image(systemName: Self.outcomeSymbol(round.outcome)).foregroundStyle(.secondary)
                }
                .font(.subheadline.weight(.semibold))
            }
            Label {
                Text("\(round.name(round.hidingTeam)) hid")
            } icon: {
                Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(round.hidingTeam))
            }
            .font(.subheadline)
            GeometryReader { g in
                let f = aborted || longest == 0 ? 0 : min(1, Double(round.observedChaseSeconds) / Double(longest))
                ZStack(alignment: .leading) {
                    Capsule().fill(.fill.tertiary)
                    Capsule().fill(aborted ? AnyShapeStyle(.gray) : AnyShapeStyle(Theme.crew(round.hidingTeam)))
                        .frame(width: max(6, g.size.width * f))
                }
            }
            .frame(height: 8)
            .accessibilityHidden(true)
            if let note {
                Label { Text(note) } icon: { Image(systemName: "arrow.triangle.swap") }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Round \(round.roundIndex)\(highlighted ? ", this round" : ""). \(round.name(round.hidingTeam)) hid. \(Self.spokenOutcome(round))\(note.map { ". Before it: \($0)" } ?? "")")
    }

    static func outcomeSymbol(_ outcome: String) -> String {
        switch outcome {
        case "CAUGHT": "camera.fill"
        case "TIMED_OUT": "hourglass"
        default: "xmark.circle"
        }
    }

    static func spokenOutcome(_ r: RoundResult) -> String {
        switch r.outcome {
        case "CAUGHT": "Caught after \(Fmt.spokenDuration(Double(r.observedChaseSeconds)))"
        case "TIMED_OUT": "Never caught, at least \(Fmt.spokenDuration(Double(r.observedChaseSeconds)))"
        default: "Aborted"
        }
    }
}

/// Section-sized explanation with an info symbol (preferred over alerts for "why").
struct ExplainerRow: View {
    let title: String
    let detail: String
    var symbol = "info.circle"
    var tint: Color = .secondary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(tint).font(.title3).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// A grid or card that fills a List row edge to edge, on the list's background.
    func bareListRow() -> some View {
        listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)
    }
}
