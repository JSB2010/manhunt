import SwiftUI
import MapKit

/// Every round of the night on one map (ADR 0020). Each round is drawn on its own: a numbered
/// circle where its hiders started and a marker where it ended (the catch, the time limit, an
/// abort). Rounds are never joined by a line: crews often drive somewhere new between rounds.
/// Focus one round to fade the others and frame it. Routes come from each round's own route
/// endpoint, so only rounds this phone played, with every phone's consent, appear.
struct NightMapView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    /// the night's finished rounds, in order
    let rounds: [RoundResult]

    @State private var routes: [Int: RouteRecap] = [:]
    @State private var unavailable: [Int: String] = [:]
    @State private var loaded = false
    /// round index in focus; nil shows the whole night
    @State private var focus: Int?
    @State private var showSeekers = false
    @State private var camera: MapCameraPosition = .automatic

    var body: some View {
        Map(position: $camera) {
            ForEach(rounds, id: \.roundId) { r in
                if let rr = routes[r.roundIndex] {
                    let faded = focus != nil && focus != r.roundIndex
                    ForEach(rr.orderedTeams.filter { $0.role == .HIDING || showSeekers }, id: \.team) { team in
                        ForEach(Array(team.segments.enumerated()), id: \.offset) { _, seg in
                            if seg.points.count > 1 {
                                MapPolyline(coordinates: seg.points.map(\.coordinate))
                                    .stroke(Theme.crew(team.team).opacity(faded ? 0.2 : 1), style: .route(team.role, width: faded ? 3 : 4))
                            }
                        }
                    }
                    if !faded {
                        if let start = rr.teams[r.hidingTeam.rawValue]?.firstPoint {
                            Annotation("", coordinate: start.coordinate, anchor: .center) {
                                RouteMarker(kind: .round(r.roundIndex), crew: r.hidingTeam, label: "Round \(r.roundIndex): \(r.name(r.hidingTeam)) started hiding here")
                            }
                        }
                        if let end = endPoint(r, rr) {
                            Annotation("", coordinate: end.coordinate, anchor: .center) {
                                RouteMarker(kind: endKind(r), crew: r.outcome == "CAUGHT" ? nil : r.hidingTeam, small: true, label: "Round \(r.roundIndex): \(RecapText.headline(r).lowercased()) here", badge: r.roundIndex)
                            }
                        }
                    }
                }
            }
        }
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
        .overlay(alignment: .topLeading) { RouteLegend(showSeekers: showSeekers).padding(12) }
        .overlay {
            if loaded && routes.isEmpty {
                ContentUnavailableView("No Routes to Show", systemImage: "map", description: Text(unavailable.isEmpty ? "No rounds have finished yet." : "Routes show for rounds this phone played, once every phone in them agreed to sharing routes."))
                    .background(.regularMaterial)
            } else if !loaded {
                ProgressView("Loading routes…").padding().glassSurface(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { picker.padding(.horizontal).padding(.bottom, 8) }
        .navigationTitle("Night Map")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Toggle(isOn: $showSeekers) { Label("Show Seekers", systemImage: "car.fill") }
                    .toggleStyle(.button)
                    .accessibilityHint("Adds the seeking crews' driving routes")
            }
        }
        .task { await load() }
    }

    // MARK: Round picker

    private var picker: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    chip(nil, title: "All", crew: nil)
                    ForEach(rounds, id: \.roundId) { r in chip(r.roundIndex, title: "\(r.roundIndex)", crew: r.hidingTeam) }
                }
                .padding(.vertical, 2)
            }
            caption
        }
        .padding(12)
        .glassSurface(in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }

    private func chip(_ index: Int?, title: String, crew: TeamKey?) -> some View {
        let on = focus == index
        let missing = index.map { routes[$0] == nil } ?? false
        return Button { select(index) } label: {
            HStack(spacing: 6) {
                if let crew { CrewDot(key: crew) }
                Text(title).monospacedDigit()
                if missing && loaded { Image(systemName: "lock.fill").font(.caption2).accessibilityHidden(true) }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(on ? AnyShapeStyle(.tint.opacity(0.25)) : AnyShapeStyle(.fill.tertiary), in: Capsule())
            .overlay(Capsule().stroke(on ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear), lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(index.map { "Round \($0)" } ?? "All rounds")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityValue(missing && loaded ? "Route not available" : "")
    }

    @ViewBuilder private var caption: some View {
        if let i = focus, let r = rounds.first(where: { $0.roundIndex == i }) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Round \(i): \(r.name(r.hidingTeam)) hid · \(RecapText.headline(r))")
                    .font(.subheadline.weight(.semibold))
                if let why = unavailable[i] {
                    Text(why).font(.footnote).foregroundStyle(.secondary)
                } else {
                    NavigationLink { RoundRecapView(sessionId: sessionId, roundId: r.roundId) } label: {
                        Text("Open Round \(i)").font(.footnote.weight(.semibold))
                    }
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("\(rounds.count) \(rounds.count == 1 ? "round" : "rounds"). Numbers mark where the hiders started; tap one to focus it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func select(_ index: Int?) {
        focus = index
        guard let index, let rr = routes[index] else { camera = .automatic; return }
        let points = rr.teams.values.flatMap { $0.segments.flatMap { $0.points.map(\.coordinate) } }
        var rect = MKMapRect.null
        for c in points { rect = rect.union(MKMapRect(origin: MKMapPoint(c), size: MKMapSize(width: 1, height: 1))) }
        guard !rect.isNull else { return }
        let pad = max(rect.width, rect.height) * 0.25 + 300
        camera = .rect(rect.insetBy(dx: -pad, dy: -pad))
    }

    // MARK: Ends

    private func endPoint(_ r: RoundResult, _ rr: RouteRecap) -> RouteRecap.Point? {
        if r.outcome == "CAUGHT", let cp = rr.markers.claimPoint { return cp }
        return rr.teams[r.hidingTeam.rawValue]?.lastPoint
    }

    private func endKind(_ r: RoundResult) -> RouteMarker.Kind {
        switch r.outcome {
        case "CAUGHT": .caught
        case "TIMED_OUT": .timedOut
        default: .aborted
        }
    }

    // MARK: Loading

    private func load() async {
        let api = model.api
        let sid = sessionId
        await withTaskGroup(of: (Int, RouteRecap?, String?).self) { group in
            for r in rounds {
                group.addTask {
                    do { return (r.roundIndex, try await api.routes(sid, r.roundId), nil) } catch {
                        let code = (error as? APIError)?.code
                        let why = code == "CONSENT_REQUIRED" ? "Not every phone in this round agreed to sharing routes."
                            : code == "NOT_FOUND" ? "This phone didn’t play this round."
                            : error.localizedDescription
                        return (r.roundIndex, nil, why)
                    }
                }
            }
            for await (index, route, why) in group {
                if let route { routes[index] = route } else if let why { unavailable[index] = why }
            }
        }
        loaded = true
    }
}
