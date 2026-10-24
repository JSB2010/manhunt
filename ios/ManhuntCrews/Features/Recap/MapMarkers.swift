import SwiftUI
import MapKit

/// Markers shared by the game map, the round map and the night map. The shape and symbol say
/// what a marker is; the colour is the crew (never the role), so nothing relies on colour alone.
struct RouteMarker: View {
    enum Kind {
        /// where a crew's route began, with its role this round
        case start(Role)
        /// where the hiders' route ended
        case end
        /// a round's start on the night map, by number
        case round(Int)
        /// where the catch photo was taken
        case caught
        /// a round that ran to the time cap
        case timedOut
        case aborted
    }

    let kind: Kind
    /// nil for the catch (accent) and aborted (grey) markers
    var crew: TeamKey?
    var small = false
    /// spoken by VoiceOver; nil hides the marker (its map item carries the words)
    var label: String?
    /// a round number on the corner (the night map's ends, so each end reads with its start)
    var badge: Int?
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 28

    private var fill: Color {
        switch kind {
        case .caught: .accentColor
        case .aborted: .gray
        default: crew.map(Theme.crew) ?? .accentColor
        }
    }
    private var ink: Color { crew.map(Theme.onCrew) ?? .white }

    var body: some View {
        let d = small ? size * 0.8 : size
        // Ends are rounded squares and starts are circles: shape tells them apart, not colour.
        let shape = kind.isEnd ? AnyShape(RoundedRectangle(cornerRadius: d * 0.28, style: .continuous)) : AnyShape(Circle())
        ZStack {
            shape.fill(fill)
            if case let .round(n) = kind {
                Text("\(n)")
                    .font(.system(size: d * 0.5, weight: .heavy, design: .rounded))
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(ink)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: d * 0.45, weight: .bold))
                    .foregroundStyle(ink)
            }
        }
        .frame(width: d, height: d)
        .overlay(shape.stroke(.white, lineWidth: 2))
        .overlay(alignment: .topTrailing) {
            if let badge {
                Text("\(badge)")
                    .font(.system(size: d * 0.36, weight: .heavy, design: .rounded))
                    .foregroundStyle(.black)
                    .frame(minWidth: d * 0.5, minHeight: d * 0.5)
                    .background(.white, in: Circle())
                    .offset(x: d * 0.22, y: -d * 0.22)
            }
        }
        .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label ?? "")
        .accessibilityHidden(label == nil)
    }

    private var symbol: String {
        switch kind {
        case let .start(role): role.symbol
        case .end: "flag.checkered"
        case .round: ""
        case .caught: "camera.fill"
        case .timedOut: "hourglass"
        case .aborted: "xmark"
        }
    }
}

private extension RouteMarker.Kind {
    var isEnd: Bool {
        switch self {
        case .end, .caught, .timedOut, .aborted: true
        default: false
        }
    }
}

/// A released ping on a finished round's map: the game's diamond, small and numbered.
struct PingDiamond: View {
    let index: Int
    let crew: TeamKey
    @ScaledMetric(relativeTo: .caption) private var size: CGFloat = 22

    var body: some View {
        ZStack {
            Image(systemName: "diamond.fill")
                .font(.system(size: size, weight: .bold))
                .foregroundStyle(Theme.crew(crew))
            Image(systemName: "diamond")
                .font(.system(size: size, weight: .bold))
                .foregroundStyle(.white.opacity(0.9))
            Text("\(index)")
                .font(.system(size: size * 0.4, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.onCrew(crew))
        }
        .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
        .accessibilityHidden(true)
    }
}

/// Map legend: line style for on foot vs by car (colour is the crew, so the style carries the mode).
struct RouteLegend: View {
    var showSeekers = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            row(dash: [], text: "Hiders on foot")
            if showSeekers { row(dash: [5, 4], text: "Seekers by car") }
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func row(dash: [CGFloat], text: String) -> some View {
        HStack(spacing: 6) {
            Path { p in p.move(to: CGPoint(x: 0, y: 5)); p.addLine(to: CGPoint(x: 22, y: 5)) }
                .stroke(.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: dash))
                .frame(width: 22, height: 10)
                .accessibilityHidden(true)
            Text(text)
        }
    }
}

/// Line style of a route: solid on foot, dashed by car.
extension StrokeStyle {
    static func route(_ role: Role, width: CGFloat = 4) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: role == .SEEKING ? [8, 6] : [])
    }
}
