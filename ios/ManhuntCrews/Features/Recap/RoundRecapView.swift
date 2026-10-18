import SwiftUI
import MapKit

/// Post-round recap (spec §6.1, screen 12): official time, separate walking vs.
/// driving distances, both routes (only after completion), pings, photo,
/// timeline, disputes and the explicit next-round flow. No round winner.
struct RoundRecapView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    let roundId: String
    /// Live view when shown from the active night (enables next-round controls).
    var live: SessionViewDoc?

    @State private var summary: RoundSummary?
    @State private var routes: RouteRecap?
    @State private var routesError: String?
    @State private var photo: UIImage?
    @State private var busy = false
    @State private var error: String?
    @State private var overrideTeam: TeamKey?
    @State private var overrideReason = ""
    @State private var showOverride = false

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let s = summary, let r = s.result {
                    header(s, r)
                    RecapMap(summary: s, routes: routes)
                        .frame(height: 320)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.corner))
                    if let routesError { Text(routesError).font(.footnote).foregroundStyle(.secondary) }
                    stats(s, r)
                    if let photo {
                        VStack(alignment: .leading) {
                            Text("Catch photo").font(.headline)
                            Image(uiImage: photo).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    pings(s)
                    claims(s)
                    timeline(s)
                } else {
                    ProgressView("Computing recap…").frame(maxWidth: .infinity, minHeight: 200)
                }
                if let live { nextRoundControls(live) }
            }
            .padding()
        }
        .navigationTitle("Round \(summary?.index ?? live?.round?.index ?? 0) recap")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if live != nil { ToolbarItem(placement: .cancellationAction) { Button("Close") { model.closeSession() } } }
        }
        .task(id: live?.round?.result?.observedChaseSeconds) { await load() }
        .refreshable { await load() }
        .confirmationDialog("Who hides next?", isPresented: $showOverride, titleVisibility: .visible) {
            if let live {
                ForEach(TeamKey.allCases) { k in
                    Button(live.session.team(k)?.name ?? k.rawValue) { overrideTeam = k; createNext(live) }
                }
            }
        } message: { Text("Overrides of the suggested alternation are recorded in history.") }
        .errorAlert($error)
    }

    private func load() async {
        for attempt in 0..<6 {
            do {
                let s = try await model.api.summary(sessionId, roundId)
                summary = s
                if s.summaryReady || attempt == 5 { break }
            } catch { self.error = error.localizedDescription; break }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        guard let s = summary else { return }
        if s.routesAvailable {
            do { routes = try await model.api.routes(sessionId, roundId) } catch { routesError = error.localizedDescription }
        } else {
            routesError = "Routes are hidden until both operators have agreed to post-round route sharing."
        }
        if let claim = s.claims.first(where: { $0.status == "CONFIRMED" }), let path = claim.photoPath, let data = try? await model.api.photo(path: path) {
            photo = UIImage(data: data)
        }
    }

    // MARK: Sections

    private func header(_ s: RoundSummary, _ r: RoundResult) -> some View {
        Card {
            HStack {
                StatusPill(text: "\(r.hidingTeamName) hid", color: Theme.hiding)
                StatusPill(text: "\(r.seekingTeamName) sought", color: Theme.seeking)
            }
            switch r.outcome {
            case "CAUGHT":
                Text("Caught after \(Fmt.clock(Double(r.observedChaseSeconds)))").font(.largeTitle.weight(.heavy)).monospacedDigit()
                    .accessibilityIdentifier("recap.outcome")
                Text("Official time = server submission of the confirmed photo\(r.resolvedByDispute ? " (resolved jointly after the round)" : "").").font(.footnote).foregroundStyle(.secondary)
            case "TIMED_OUT":
                Text("Not caught: survived ≥ \(Fmt.clock(Double(r.observedChaseSeconds)))").font(.title.weight(.heavy))
                Text("Time limit reached. This is a lower bound (censored), not a catch time.").font(.footnote).foregroundStyle(.secondary)
            default:
                Text("Round aborted").font(.title.weight(.heavy))
                if let reason = r.abortedReason { Text(reason).font(.callout) }
                Text("Aborted rounds are excluded from comparisons.").font(.footnote).foregroundStyle(.secondary)
            }
            Text("One round is one attempt — there's no round winner. Compare crews across the night.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func stats(_ s: RoundSummary, _ r: RoundResult) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Stats").font(.headline)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                StatTile(label: "Head start", value: Fmt.clock(Double(r.headStartSeconds)))
                StatTile(label: "Pauses", value: Fmt.clock(Double(r.totalPauseSeconds)))
                StatTile(label: "Hiders on foot (total)", value: Fmt.distance(r.hidingDistanceTotalMeters, units: units), footnote: "incl. head start · \(quality(r.routeQualityHider))")
                StatTile(label: "Hiders on foot (chase)", value: Fmt.distance(r.hidingDistanceChaseMeters, units: units))
                StatTile(label: "Seekers by car (chase)", value: Fmt.distance(r.seekingDistanceChaseMeters, units: units), footnote: quality(r.routeQualitySeeker))
                StatTile(label: "GPS coverage", value: "\(Fmt.percent(r.gpsCoverageFractionHider)) / \(Fmt.percent(r.gpsCoverageFractionSeeker))", footnote: "hiders / seekers")
                StatTile(label: "Pings released", value: "\(r.pingsReleased) of \(r.pingSlots)", footnote: r.pingsMissing > 0 ? "\(r.pingsMissing) unavailable" : nil)
                StatTile(label: "Round duration", value: Fmt.clock(Double(r.roundElapsedSeconds)), footnote: "wall clock")
            }
            Text("Walking and driving distances are reported separately and never combined into one score. Distances come from the operator phones as a proxy for each crew.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func quality(_ q: String) -> String {
        switch q {
        case "GOOD": "good GPS"
        case "ESTIMATED": "estimated from available GPS"
        case "DELETED": "route deleted"
        default: "insufficient GPS"
        }
    }

    private func pings(_ s: RoundSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Pings").font(.headline)
            ForEach(s.pings) { p in
                HStack {
                    Image(systemName: p.status == "RELEASED" ? "diamond.fill" : "location.slash").foregroundStyle(p.status == "RELEASED" ? Theme.hiding : .orange)
                    Text("#\(p.index) at \(Fmt.time(p.scheduledAt))")
                    Spacer()
                    if p.status == "RELEASED" {
                        Text("sample age \(p.ageSeconds ?? 0)s · ±\(Int(p.accuracyMeters ?? 0)) m").foregroundStyle(.secondary)
                    } else {
                        Text("no fresh fix").foregroundStyle(.orange)
                    }
                }
                .font(.callout)
            }
            if s.pings.isEmpty { Text("No pings were due.").foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private func claims(_ s: RoundSummary) -> some View {
        let disputable = s.claims.filter { $0.status == "REJECTED" || $0.status == "EXPIRED" }
        if !s.claims.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Catch claims").font(.headline)
                ForEach(s.claims) { c in
                    HStack {
                        Text("\(Fmt.time(c.submittedAt)) · \(c.status.lowercased())\(c.rejectionReason.map { " — \($0)" } ?? "")")
                        Spacer()
                        if let t = c.chaseSecondsAtClaim { Text(Fmt.clock(Double(t))).monospacedDigit() }
                    }
                    .font(.callout)
                }
                if !disputable.isEmpty {
                    Text("Disputed a rejected claim? Both operators can jointly accept it as the catch. Either side can also keep it rejected.").font(.caption).foregroundStyle(.secondary)
                    ForEach(disputable) { c in
                        HStack {
                            Button("Accept \(Fmt.time(c.submittedAt)) claim") { dispute(c, accept: true) }
                            Button("Keep rejected") { dispute(c, accept: false) }
                        }
                        .buttonStyle(.bordered)
                        .font(.caption)
                    }
                }
            }
        }
    }

    private func timeline(_ s: RoundSummary) -> some View {
        DisclosureGroup("Timeline (\(s.timeline.count) events)") {
            ForEach(s.timeline) { e in
                HStack {
                    Text(Fmt.time(e.at)).monospacedDigit().foregroundStyle(.secondary)
                    Text(e.type.replacingOccurrences(of: "_", with: " ").capitalized)
                    Spacer()
                }
                .font(.caption)
            }
        }
    }

    // MARK: Next round

    @ViewBuilder private func nextRoundControls(_ live: SessionViewDoc) -> some View {
        Card {
            if live.session.status == .COMPLETED {
                Text("Night complete").font(.title2.bold())
                NavigationLink { NightSummaryView(sessionId: sessionId) } label: { Label("Night summary & scorecard", systemImage: "trophy") }
                    .buttonStyle(.borderedProminent)
            } else if let next = live.nextRound {
                let hider = live.session.team(next.suggestedHidingTeam)?.name ?? next.suggestedHidingTeam.rawValue
                Text("Round \(next.index): \(hider) hides next").font(.title3.bold())
                Text("Roles switch; each operator stays with their own crew. Physically reposition, check both phones, then both tap Ready. Nothing starts automatically.")
                    .font(.callout).foregroundStyle(.secondary)
                if live.session.isHost {
                    BigButton(title: "Set up round \(next.index)", systemImage: "arrow.triangle.2.circlepath", busy: busy) { overrideTeam = nil; createNext(live) }
                        .accessibilityIdentifier("recap.nextRound")
                    Button("Change who hides…") { showOverride = true }.font(.callout)
                    Button("End the night now") { perform($busy, $error) { try await model.api.completeSession(sessionId) } }.font(.callout)
                } else {
                    Label("Waiting for the host to set up round \(next.index)…", systemImage: "hourglass")
                }
                NavigationLink { NightSummaryView(sessionId: sessionId) } label: { Label("Night so far", systemImage: "list.number") }
            }
        }
    }

    private func createNext(_ live: SessionViewDoc) {
        let suggestion = live.nextRound?.suggestedHidingTeam
        let team = overrideTeam
        perform($busy, $error) {
            _ = try await model.api.nextRound(sessionId, hidingTeam: team, overrideReason: team != nil && team != suggestion ? "Host override" : nil)
        }
    }

    private func dispute(_ c: RoundSummary.Claim, accept: Bool) {
        perform($busy, $error) {
            try await model.api.dispute(sessionId, roundId, claimId: c.claimId, accept: accept)
            model.show("Proposal recorded — the other operator must agree")
            await load()
        }
    }
}

/// Both crews' completed routes (static polylines with markers).
struct RecapMap: View {
    let summary: RoundSummary
    let routes: RouteRecap?

    var body: some View {
        Map {
            if let routes {
                ForEach(Array(routes.teams.values), id: \.team) { team in
                    let color = Color(hex: summary.teamColors[team.team.rawValue] ?? (team.role == .HIDING ? "#1E88E5" : "#F4511E"))
                    ForEach(Array(team.segments.enumerated()), id: \.offset) { _, seg in
                        if seg.points.count > 1 {
                            MapPolyline(coordinates: seg.points.map(\.coordinate))
                                .stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round, dash: team.role == .SEEKING ? [8, 5] : []))
                        }
                    }
                    if let first = team.segments.first?.points.first {
                        Annotation("\(summary.teamNames[team.team.rawValue] ?? "") start", coordinate: first.coordinate) {
                            Image(systemName: "flag.fill").foregroundStyle(color)
                        }
                    }
                }
                if let cp = routes.markers.claimPoint {
                    Annotation("Catch", coordinate: cp.coordinate) { Image(systemName: "camera.circle.fill").font(.title).foregroundStyle(Theme.seeking) }
                }
            }
            ForEach(summary.pings.filter { $0.coordinate != nil }) { p in
                Annotation("#\(p.index)", coordinate: p.coordinate!) {
                    Image(systemName: "diamond.fill").foregroundStyle(Theme.hiding).shadow(radius: 2)
                }
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 10) {
                Label("Hiders (on foot)", systemImage: "line.diagonal").foregroundStyle(Theme.hiding)
                Label("Seekers (car, dashed)", systemImage: "line.diagonal").foregroundStyle(Theme.seeking)
            }
            .font(.caption2.weight(.semibold))
            .padding(6)
            .background(.thickMaterial, in: Capsule())
            .padding(8)
        }
    }
}
