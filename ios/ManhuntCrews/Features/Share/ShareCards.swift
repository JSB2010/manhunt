import SwiftUI
import MapKit

// Share cards (ADR 0020): an image made on this phone from what it already shows after a round,
// for the person to share or save. Nothing is uploaded; no CSV or JSON (those stay under Data).
// Cards are drawn dark at 4:5 (1080 × 1350 px), the shape photo apps crop to least.

enum ShareCardStyle {
    static let size = CGSize(width: 360, height: 450)
    static let scale: CGFloat = 3
}

/// Renders a card view to an image on the main actor (ImageRenderer can't draw a live Map,
/// so cards take a map snapshot image instead).
@MainActor
enum ShareCardRenderer {
    static func image(_ card: some View) -> UIImage? {
        let renderer = ImageRenderer(content: card
            .frame(width: ShareCardStyle.size.width, height: ShareCardStyle.size.height)
            .environment(\.colorScheme, .dark)
            .environment(\.dynamicTypeSize, .large))
        renderer.scale = ShareCardStyle.scale
        return renderer.uiImage
    }
}

// MARK: - Map snapshot

/// A static picture of a round's routes, pings and catch, drawn over an Apple Maps snapshot.
enum RouteSnapshot {
    static func render(summary: RoundSummary, routes: RouteRecap?, size: CGSize) async -> UIImage? {
        let pings = summary.pings.compactMap(\.coordinate)
        let routePoints = routes?.teams.values.flatMap { $0.segments.flatMap { $0.points.map(\.coordinate) } } ?? []
        let all = routePoints + pings + [routes?.markers.claimPoint?.coordinate].compactMap { $0 }
        guard !all.isEmpty else { return nil }
        var rect = MKMapRect.null
        for c in all { rect = rect.union(MKMapRect(origin: MKMapPoint(c), size: MKMapSize(width: 1, height: 1))) }
        // Room around the routes for the markers (and a sensible area for a single point).
        let pad = max(rect.width, rect.height) * 0.18 + 400
        rect = rect.insetBy(dx: -pad, dy: -pad)

        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(rect)
        options.size = size
        options.scale = ShareCardStyle.scale
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        options.pointOfInterestFilter = .excludingAll
        guard let snap = try? await MKMapSnapshotter(options: options).start() else { return nil }

        let format = UIGraphicsImageRendererFormat()
        format.scale = ShareCardStyle.scale
        let dark = UITraitCollection(userInterfaceStyle: .dark)
        let crew = { (k: TeamKey) in UIColor(Theme.crew(k)).resolvedColor(with: dark) }
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            snap.image.draw(at: .zero)
            let g = ctx.cgContext
            g.setLineCap(.round)
            g.setLineJoin(.round)
            for team in routes?.orderedTeams ?? [] {
                g.setStrokeColor(crew(team.team).cgColor)
                g.setLineWidth(team.role == .HIDING ? 4 : 3)
                g.setLineDash(phase: 0, lengths: team.role == .SEEKING ? [7, 5] : [])
                for seg in team.segments where seg.points.count > 1 {
                    g.beginPath()
                    g.addLines(between: seg.points.map { snap.point(for: $0.coordinate) })
                    g.strokePath()
                }
                if let first = team.firstPoint { dot(g, snap.point(for: first.coordinate), crew(team.team), 6) }
            }
            g.setLineDash(phase: 0, lengths: [])
            for p in pings { diamond(g, snap.point(for: p), crew(summary.hidingTeam)) }
            if let cp = routes?.markers.claimPoint { dot(g, snap.point(for: cp.coordinate), UIColor(Color.accentColor).resolvedColor(with: dark), 8) }
        }
    }

    private static func dot(_ g: CGContext, _ p: CGPoint, _ color: UIColor, _ r: CGFloat) {
        let rect = CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)
        g.setLineDash(phase: 0, lengths: [])
        g.setFillColor(color.cgColor)
        g.fillEllipse(in: rect)
        g.setStrokeColor(UIColor.white.cgColor)
        g.setLineWidth(2)
        g.strokeEllipse(in: rect)
    }

    private static func diamond(_ g: CGContext, _ p: CGPoint, _ color: UIColor) {
        let r: CGFloat = 6
        g.beginPath()
        g.move(to: CGPoint(x: p.x, y: p.y - r))
        g.addLine(to: CGPoint(x: p.x + r, y: p.y))
        g.addLine(to: CGPoint(x: p.x, y: p.y + r))
        g.addLine(to: CGPoint(x: p.x - r, y: p.y))
        g.closePath()
        g.setFillColor(color.cgColor)
        g.setStrokeColor(UIColor.white.cgColor)
        g.setLineWidth(1.5)
        g.drawPath(using: .fillStroke)
    }
}

// MARK: - Cards

/// Shared frame of every card: the app's name, a title line, content, the date.
private struct CardFrame<Content: View>: View {
    let kicker: String
    let date: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(kicker.uppercased())
                .font(.caption.weight(.bold))
                .kerning(1.2)
                .foregroundStyle(.secondary)
            content
            Spacer(minLength: 0)
            HStack {
                Label("Manhunt Crews", systemImage: "flag.2.crossed.fill")
                Spacer()
                Text(date)
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
        }
        .padding(22)
        .frame(width: ShareCardStyle.size.width, height: ShareCardStyle.size.height, alignment: .topLeading)
        .background(Color(white: 0.07))
        .foregroundStyle(.white)
    }
}

/// A round: the outcome, who hid and sought, the map, two or three numbers, its highlights.
struct RoundShareCard: View {
    let result: RoundResult
    let map: UIImage?
    let highlights: [NightHighlight]
    let units: String
    let date: String

    var body: some View {
        CardFrame(kicker: "Round \(result.roundIndex)", date: date) {
            Text(RecapText.headline(result))
                .font(.system(size: 32, weight: .bold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            VStack(alignment: .leading, spacing: 4) {
                crewLine(result.hidingTeam, "\(result.name(result.hidingTeam)) hid")
                if let k = result.catchCreditTeams.first ?? result.seekingTeams.first { crewLine(k, RecapText.seekersLine(result)) }
            }
            .font(.subheadline.weight(.semibold))
            if let map {
                Image(uiImage: map)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .frame(height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            HStack(spacing: 8) {
                ForEach(RecapText.cardNumbers(result, units: units), id: \.label) { n in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.value).font(.headline).fontDesign(.rounded).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                        Text(n.label).font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            ForEach(highlights.prefix(2)) { h in
                Label(StatsText.badge(h.kind, live: false), systemImage: "star.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.yellow)
            }
        }
    }

    private func crewLine(_ k: TeamKey, _ text: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.crew(k)).frame(width: 9, height: 9)
            Text(text).lineLimit(1)
        }
    }
}

/// The catch photo, full bleed, with the time and who found whom over a gradient.
struct CatchShareCard: View {
    let photo: UIImage
    let result: RoundResult
    let date: String

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Image(uiImage: photo)
                .resizable()
                .scaledToFill()
                .frame(width: ShareCardStyle.size.width, height: ShareCardStyle.size.height)
                .clipped()
            LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 6) {
                Text("Round \(result.roundIndex) · Caught".uppercased())
                    .font(.caption.weight(.bold))
                    .kerning(1.2)
                    .foregroundStyle(.white.opacity(0.8))
                Text(Fmt.clock(Double(result.observedChaseSeconds)))
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("\(result.catchCreditTeams.map(result.name).formatted(.list(type: .and))) found \(result.name(result.hidingTeam))")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Text("Manhunt Crews · \(date)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .foregroundStyle(.white)
            .padding(22)
        }
        .frame(width: ShareCardStyle.size.width, height: ShareCardStyle.size.height)
    }
}

/// A night: its verdict, its highlights, every round as a bar.
struct NightShareCard: View {
    let title: String
    let date: String
    let verdict: StatsText.Verdict
    let highlights: [NightHighlight]
    let rounds: [RoundResult]
    let units: String

    var body: some View {
        CardFrame(kicker: title, date: date) {
            Text(verdict.title)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(highlights.prefix(4)) { h in
                    HStack(spacing: 8) {
                        Image(systemName: StatsText.symbol(h.kind))
                            .foregroundStyle(h.teams.first.map(Theme.crew) ?? .white)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 0) {
                            Text("\(StatsText.title(h.kind)) · \(StatsText.value(h, units: units))").font(.subheadline.weight(.semibold)).monospacedDigit()
                            Text("\(h.names.formatted(.list(type: .and))) · Round \(h.roundIndex)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            let longest = max(1, rounds.filter { $0.outcome != "ABORTED" }.map(\.observedChaseSeconds).max() ?? 1)
            VStack(alignment: .leading, spacing: 5) {
                ForEach(rounds.suffix(8), id: \.roundId) { r in
                    HStack(spacing: 8) {
                        Text("R\(r.roundIndex)").font(.caption2.weight(.bold)).frame(width: 24, alignment: .leading)
                        GeometryReader { g in
                            Capsule().fill(r.outcome == "ABORTED" ? Color.gray : Theme.crew(r.hidingTeam))
                                .frame(width: r.outcome == "ABORTED" ? 6 : max(6, g.size.width * Double(r.observedChaseSeconds) / Double(longest)))
                        }
                        .frame(height: 7)
                        Text(Fmt.outcome(r.outcome, seconds: r.observedChaseSeconds)).font(.caption2).monospacedDigit().frame(width: 56, alignment: .trailing)
                    }
                }
            }
        }
    }
}

// MARK: - Sheet

/// Preview a card and share or save it. Several kinds (map, photo) switch with a segmented control.
struct ShareCardSheet: View {
    struct Option: Identifiable, Hashable {
        let id: String
        let title: String
    }

    let title: String
    let options: [Option]
    let render: @MainActor (Option) async -> UIImage?
    @State private var selection: Option?
    @State private var image: UIImage?
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if options.count > 1 {
                    Picker("Card", selection: Binding(get: { selection ?? options[0] }, set: { selection = $0 })) {
                        ForEach(options) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Group {
                    if let image {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .shadow(color: .black.opacity(0.2), radius: 12, y: 4)
                            .accessibilityLabel("Preview of the \((selection ?? options[0]).title.lowercased()) card")
                    } else if failed {
                        ContentUnavailableView("Couldn’t Make the Card", systemImage: "photo.badge.exclamationmark")
                    } else {
                        ProgressView("Making the card…")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } } }
            .bottomActionBar {
                if let image {
                    let picture = Image(uiImage: image)
                    ShareLink(item: picture, preview: SharePreview(title, image: picture)) {
                        ActionLabel(title: "Share", systemImage: "square.and.arrow.up")
                    }
                    .floatingProminentButton()
                    .controlSize(.large)
                    .accessibilityIdentifier("share.send")
                }
            }
            .task(id: selection ?? options.first) {
                image = nil
                failed = false
                guard let option = selection ?? options.first else { return }
                image = await render(option)
                failed = image == nil
            }
        }
    }
}
