import SwiftUI
import MapKit

/// A finished round's map: every crew's route (solid on foot, dashed by car), where each crew
/// started, where the hiders ended or were caught, and the numbered pings. With `until`, it shows
/// the round up to that moment (the replay): routes so far, each crew's position then, the pings
/// released by then. Shown only after the round (spec §6.1); routes only with every phone's consent.
struct RecapMap: View {
    let summary: RoundSummary
    let routes: RouteRecap?
    var interactive = true
    var until: Date?

    private var hiding: TeamKey { summary.hidingTeam }
    private func name(_ k: TeamKey) -> String { summary.teamNames[k.rawValue] ?? k.colourName }

    var body: some View {
        Map(interactionModes: interactive ? .all : []) {
            if let routes {
                ForEach(routes.orderedTeams, id: \.team) { team in
                    let color = Theme.crew(team.team)
                    ForEach(Array(team.segments.enumerated()), id: \.offset) { _, seg in
                        if seg.points.count > 1 {
                            if until != nil {
                                // The whole route faint; the part travelled by then is drawn solid below.
                                MapPolyline(coordinates: seg.points.map(\.coordinate))
                                    .stroke(color.opacity(0.25), style: .route(team.role))
                            } else {
                                MapPolyline(coordinates: seg.points.map(\.coordinate)).stroke(color, style: .route(team.role))
                            }
                        }
                    }
                    if let until {
                        ForEach(Array(team.travelled(by: until).enumerated()), id: \.offset) { _, sofar in
                            if sofar.count > 1 { MapPolyline(coordinates: sofar).stroke(color, style: .route(team.role)) }
                        }
                    }
                    if let first = team.firstPoint {
                        Annotation("", coordinate: first.coordinate, anchor: .center) {
                            RouteMarker(kind: .start(team.role), crew: team.team, small: true, label: "\(name(team.team)) started here, \(team.role == .HIDING ? "hiding" : "seeking")")
                        }
                    }
                    if let until, let now = team.position(at: until) {
                        Annotation("", coordinate: now, anchor: .center) {
                            Circle().fill(color).frame(width: 16, height: 16)
                                .overlay(Circle().stroke(.white, lineWidth: 3))
                                .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
                                .accessibilityLabel("\(name(team.team)) at this moment")
                        }
                    }
                }
                if showEnd, let end = routes.teams[hiding.rawValue]?.lastPoint {
                    Annotation("", coordinate: end.coordinate, anchor: .center) {
                        RouteMarker(kind: endKind, crew: hiding, label: endLabel)
                    }
                }
                if let cp = routes.markers.claimPoint, until.map({ $0 >= (cp.t ?? .distantPast) }) ?? true {
                    Annotation("", coordinate: cp.coordinate, anchor: .center) {
                        RouteMarker(kind: .caught, label: "Catch photo taken here")
                    }
                }
            }
            ForEach(summary.pings.filter { p in p.coordinate != nil && until.map { (p.releasedAt ?? .distantPast) <= $0 } ?? true }) { p in
                Annotation("", coordinate: p.coordinate!, anchor: .center) {
                    PingDiamond(index: p.index, crew: hiding)
                        .accessibilityElement()
                        .accessibilityLabel("Ping \(p.index), \(Fmt.time(p.scheduledAt))")
                }
            }
        }
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
    }

    /// The hiders' end gets its own marker unless the catch point already marks it.
    private var showEnd: Bool {
        guard routes?.markers.claimPoint == nil else { return false }
        return until.map { $0 >= (routes?.markers.officialEndAt ?? .distantFuture) } ?? true
    }
    private var endKind: RouteMarker.Kind {
        switch summary.result?.outcome {
        case "TIMED_OUT": .timedOut
        case "ABORTED": .aborted
        default: .end
        }
    }
    private var endLabel: String {
        switch summary.result?.outcome {
        case "TIMED_OUT": "\(name(hiding)) here at the time limit, never caught"
        case "ABORTED": "\(name(hiding)) here when the round was aborted"
        default: "\(name(hiding)) here at the end"
        }
    }
}

/// The round's map full screen, with a replay scrubber: drag through the round, or play it.
struct RouteReplayView: View {
    let summary: RoundSummary
    let routes: RouteRecap?
    /// 0 = round start, 1 = the end
    @State private var progress: Double = 1
    @State private var playing = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var start: Date? { routes?.markers.roundStartAt ?? summary.roundStartAt }
    private var end: Date? { routes?.markers.officialEndAt ?? summary.endedAt }
    private var moment: Date? {
        guard let start, let end, end > start else { return nil }
        return start.addingTimeInterval(end.timeIntervalSince(start) * progress)
    }

    var body: some View {
        RecapMap(summary: summary, routes: routes, interactive: true, until: progress < 1 ? moment : nil)
            .overlay(alignment: .topLeading) { RouteLegend().padding(12) }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let moment { scrubber(moment).padding(.horizontal).padding(.bottom, 8) }
            }
            .task(id: playing) { await play() }
    }

    private func scrubber(_ moment: Date) -> some View {
        HStack(spacing: 12) {
            Button {
                if progress >= 1 { progress = 0 }
                playing.toggle()
            } label: {
                Label(playing ? "Pause Replay" : "Play Replay", systemImage: playing ? "pause.fill" : "play.fill")
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 24, minHeight: 24)
            }
            .floatingButton()
            .buttonBorderShape(.circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(phase(at: moment))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Slider(value: $progress, in: 0...1) { Text("Replay position") } onEditingChanged: { editing in
                    if editing { playing = false }
                }
                .accessibilityValue(phase(at: moment))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassSurface(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    /// "Head start · 9:12:30 PM", "Chase · 9:31:02 PM", "End · …" — wall-clock time, labelled by phase.
    private func phase(at t: Date) -> String {
        let when = t.formatted(date: .omitted, time: .standard)
        if progress >= 1 { return "End · \(when)" }
        if let chase = routes?.markers.chaseStartAt ?? summary.chaseStartAt, t < chase { return "Head start · \(when)" }
        return "Chase · \(when)"
    }

    /// About 20 seconds for the whole round.
    private func play() async {
        while playing && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard playing else { return }
            progress = min(1, progress + 0.005)
            if progress >= 1 { playing = false }
        }
    }
}

extension RouteRecap {
    /// Seekers first so the hiders' route draws on top.
    var orderedTeams: [Team] { teams.values.sorted { ($0.role == .HIDING ? 1 : 0, $0.team.rawValue) < ($1.role == .HIDING ? 1 : 0, $1.team.rawValue) } }
}

extension RouteRecap.Team {
    var firstPoint: RouteRecap.Point? { segments.first(where: { !$0.points.isEmpty })?.points.first }
    var lastPoint: RouteRecap.Point? { segments.last(where: { !$0.points.isEmpty })?.points.last }

    /// The route travelled by `t`, segment by segment. Routes are simplified (a straight stretch keeps
    /// only its ends), so the last leg is cut where the crew was at `t`, moving at an even pace along
    /// it. Never across a gap between segments: a gap is a gap.
    func travelled(by t: Date) -> [[CLLocationCoordinate2D]] {
        var out: [[CLLocationCoordinate2D]] = []
        for seg in segments {
            guard let first = seg.points.first, (first.t ?? .distantPast) <= t else { break }
            var sofar = [first.coordinate]
            for (a, b) in zip(seg.points, seg.points.dropFirst()) {
                guard let ta = a.t, let tb = b.t, tb > t else { sofar.append(b.coordinate); continue }
                let f = tb > ta ? max(0, min(1, t.timeIntervalSince(ta) / tb.timeIntervalSince(ta))) : 1
                sofar.append(.init(latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f))
                out.append(sofar)
                return out
            }
            out.append(sofar)
        }
        return out
    }

    /// Where the crew was at `t` (nil before its route begins; in a gap, where it was last recorded).
    func position(at t: Date) -> CLLocationCoordinate2D? { travelled(by: t).last?.last }
}
