import SwiftUI
import MapKit

/// Post-round recap (spec §6.1, screen 12): official time, per-crew walking vs.
/// driving distances, every crew's route (only after completion), pings, photo,
/// timeline, disputes and the next-round flow. No round winner — catch credit
/// (Together/Race) is attribution only.
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
    @State private var showWhoHides = false
    @State private var showEdit = false
    @State private var confirmEndNight = false
    @State private var showMap = false

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }

    var body: some View {
        List {
            if let s = summary, let r = s.result {
                Section { header(s, r) }
                Section {
                    // Static preview inside the scrolling list (so swipes scroll the page);
                    // the full-screen map is interactive.
                    Button { showMap = true } label: {
                        RecapMap(summary: s, routes: routes, interactive: false)
                            .frame(height: 300)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.mediaCorner, style: .continuous))
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: "arrow.up.left.and.arrow.down.right")
                                    .font(.body.weight(.semibold))
                                    .frame(width: 44, height: 44)
                                    .glassSurface(in: Circle())
                                    .padding(10)
                            }
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .accessibilityLabel("Route map")
                    .accessibilityHint("Opens an interactive map of every crew’s route")
                    .fullScreenCover(isPresented: $showMap) {
                        NavigationStack {
                            RecapMap(summary: s, routes: routes, interactive: true)
                                .ignoresSafeArea(edges: .bottom)
                                .navigationTitle("Routes")
                                .navigationBarTitleDisplayMode(.inline)
                                .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { showMap = false } } }
                        }
                    }
                } footer: {
                    if let routesError { Text(routesError) }
                }
                stats(s, r)
                if let photo {
                    Section("Catch Photo") {
                        Image(uiImage: photo)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .accessibilityLabel("Confirmed catch photo")
                    }
                }
                pings(s)
                claims(s)
                timeline(s)
            } else {
                Section {
                    HStack { Spacer(); ProgressView("Computing recap…"); Spacer() }
                        .padding(.vertical, 40)
                }
            }
            if let live { nextRoundSection(live) }
        }
        .navigationTitle("Round \(summary?.index ?? live?.round?.index ?? 0) Recap")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if live != nil { ToolbarItem(placement: .cancellationAction) { CloseButton { model.closeSession() } } }
        }
        .bottomActionBar {
            if let live, live.session.status != .COMPLETED, let next = live.nextRound {
                Button { createNext(hidingTeam: nil) } label: {
                    ActionLabel(title: "Next: Round \(next.index)", systemImage: "arrow.triangle.2.circlepath", busy: busy)
                }
                .floatingProminentButton()
                .controlSize(.large)
                .disabled(busy)
                .accessibilityIdentifier("recap.nextRound")
            }
        }
        .task(id: live?.round?.result?.observedChaseSeconds) { await load() }
        .refreshable { await load() }
        .confirmationDialog("Who hides next?", isPresented: $showWhoHides, titleVisibility: .visible) {
            if let live {
                ForEach(live.session.teamKeys) { k in
                    Button(live.session.name(k)) { createNext(hidingTeam: k) }
                }
            }
        }
        .confirmationDialog("End the night?", isPresented: $confirmEndNight, titleVisibility: .visible) {
            Button("End Night", role: .destructive) { perform($busy, $error) { try await model.api.completeSession(sessionId) } }
        } message: { Text("Played rounds stay in history.") }
        .sheet(isPresented: $showEdit) { if let live { EditNightSheet(view: live) } }
        .errorAlert($error)
    }

    private func load() async {
        for attempt in 0..<6 {
            do {
                let s = try await model.api.summary(sessionId, roundId)
                summary = s
                if s.summaryReady || attempt == 5 { break }
            } catch {
                // A newer result (task id change) cancels this load; that isn’t an error.
                if !Task.isCancelled { self.error = error.localizedDescription }
                break
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        guard let s = summary else { return }
        if s.routesAvailable {
            do { routes = try await model.api.routes(sessionId, roundId) } catch { routesError = error.localizedDescription }
        } else {
            routesError = "Routes show once every phone in the round has agreed to sharing them."
        }
        if let claim = s.claims.first(where: { $0.status == "CONFIRMED" }), let path = claim.photoPath, let data = try? await model.api.photo(path: path) {
            photo = UIImage(data: data)
        }
    }

    // MARK: Sections

    private func header(_ s: RoundSummary, _ r: RoundResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { roles(s, r) }
                VStack(alignment: .leading, spacing: 4) { roles(s, r) }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)

            switch r.outcome {
            case "CAUGHT":
                Text("Caught after \(Fmt.clock(Double(r.observedChaseSeconds)))")
                    .font(.largeTitle.bold())
                    .fontDesign(.rounded)
                    .monospacedDigit()
                    .accessibilityIdentifier("recap.outcome")
                if r.seekMode == .RACE, let k = r.catchCreditTeams.first {
                    Label("\(r.name(k)) made the catch", systemImage: "flag.checkered")
                        .font(.headline)
                        .foregroundStyle(Theme.crew(k))
                }
                if r.resolvedByDispute {
                    Text("Settled together after the round.").font(.footnote).foregroundStyle(.secondary)
                }
            case "TIMED_OUT":
                Text("Not caught — survived ≥ \(Fmt.clock(Double(r.observedChaseSeconds)))")
                    .font(.title.bold())
                    .fontDesign(.rounded)
                    .accessibilityIdentifier("recap.outcome")
            default:
                Text("Round Aborted")
                    .font(.title.bold())
                    .accessibilityIdentifier("recap.outcome")
                if let reason = r.abortedReason { Text(reason).font(.callout) }
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private func roles(_ s: RoundSummary, _ r: RoundResult) -> some View {
        Label { Text("\(r.name(r.hidingTeam)) hid") } icon: { Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(r.hidingTeam)) }
        Label { Text("\(r.seekersName) sought\(r.seekingTeams.count > 1 ? (r.seekMode == .RACE ? " (race)" : " (together)") : "")") } icon: {
            Image(systemName: Role.SEEKING.symbol).foregroundStyle(r.seekingTeams.first.map(Theme.crew) ?? .secondary)
        }
    }

    private func crewColor(_ s: RoundSummary, role: Role) -> Color {
        role == .HIDING ? Theme.crew(s.hidingTeam) : (s.seekingTeams.first.map(Theme.crew) ?? .secondary)
    }

    /// Distances per crew, from each crew's best-covered phone. On foot and by car are never combined.
    @ViewBuilder private func stats(_ s: RoundSummary, _ r: RoundResult) -> some View {
        Section("Distances") {
            if let h = r.crew(r.hidingTeam) {
                LabeledContent("\(r.name(r.hidingTeam)) on foot", value: Fmt.distance(h.distanceTotalMeters, units: units))
                LabeledContent("…during the chase", value: Fmt.distance(h.distanceChaseMeters, units: units))
            }
            ForEach(r.seekingTeams, id: \.self) { k in
                LabeledContent("\(r.name(k)) by car", value: Fmt.distance(r.crew(k)?.distanceChaseMeters, units: units))
            }
        }
        Section("Round") {
            LabeledContent("Head start", value: Fmt.clock(Double(r.headStartSeconds)))
            LabeledContent("Pauses", value: Fmt.clock(Double(r.totalPauseSeconds)))
            LabeledContent("Round duration", value: Fmt.clock(Double(r.roundElapsedSeconds)))
            LabeledContent("Pings released", value: "\(r.pingsReleased) of \(r.pingSlots)\(r.pingsMissing > 0 ? " (\(r.pingsMissing) missed)" : "")\(r.pingsDelayed > 0 ? " · \(r.pingsDelayed) late" : "")")
            ForEach([r.hidingTeam] + r.seekingTeams, id: \.self) { k in
                if let c = r.crew(k) {
                    LabeledContent("\(r.name(k)) GPS", value: "\(Fmt.percent(c.gpsCoverageFraction)) · \(quality(c.routeQuality))")
                }
            }
        }
        .monospacedDigit()
    }

    private func quality(_ q: String) -> String {
        switch q {
        case "GOOD": "good GPS"
        case "ESTIMATED": "estimated from the GPS available"
        case "DELETED": "deleted"
        default: "not enough GPS"
        }
    }

    @ViewBuilder private func pings(_ s: RoundSummary) -> some View {
        Section("Pings") {
            ForEach(s.pings) { p in
                HStack(spacing: 12) {
                    Image(systemName: p.status == "RELEASED" ? "diamond.fill" : "location.slash.fill")
                        .foregroundStyle(p.status == "RELEASED" ? AnyShapeStyle(crewColor(s, role: .HIDING)) : AnyShapeStyle(Theme.warning))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ping \(p.index) · \(Fmt.time(p.scheduledAt))")
                        Text(p.status == "RELEASED" ? "Sample \(p.ageSeconds ?? 0)s old · ±\(Int(p.accuracyMeters ?? 0)) m\(p.delayed ? " · late" : "")" : "No GPS got through — not revealed")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if s.pings.isEmpty { Text("No pings were due.").foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private func claims(_ s: RoundSummary) -> some View {
        // Disputes are settled by the hiding crew and the claiming crew.
        let disputable = s.claims.filter { c in (c.status == "REJECTED" || c.status == "EXPIRED") && (s.myTeam == s.hidingTeam || s.myTeam == c.team) }
        if !s.claims.isEmpty {
            Section {
                ForEach(s.claims) { c in
                    LabeledContent {
                        if let t = c.chaseSecondsAtClaim { Text(Fmt.clock(Double(t))).monospacedDigit() }
                    } label: {
                        Text("\(c.team.map { "\(s.teamNames[$0.rawValue] ?? $0.rawValue) · " } ?? "")\(Fmt.time(c.submittedAt)) · \(c.status.capitalized)")
                        if let reason = c.rejectionReason { Text(reason) }
                    }
                }
                ForEach(disputable) { c in
                    HStack {
                        Button("Accept \(Fmt.time(c.submittedAt)) Claim") { dispute(c, accept: true) }
                        Spacer()
                        Button("Keep Rejected") { dispute(c, accept: false) }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            } header: {
                Text("Catch Claims")
            } footer: {
                if !disputable.isEmpty {
                    Text("The hiders and the claiming crew can both accept a claim as the catch.")
                }
            }
        }
    }

    private func timeline(_ s: RoundSummary) -> some View {
        // The round itself: recaps from before 2026-10-23 also listed the lobby before it.
        let events = s.timeline.filter { !RoundSummary.TimelineEvent.lobbyTypes.contains($0.type) && ($0.at ?? .distantFuture) >= (s.roundStartAt ?? .distantPast) }
        return Section {
            DisclosureGroup("Timeline (\(events.count) events)") {
                ForEach(events) { e in
                    LabeledContent(e.label { k in s.teamNames[k.rawValue] ?? "Crew \(k.rawValue)" }, value: Fmt.time(e.at))
                        .font(.subheadline)
                        .monospacedDigit()
                }
            }
        }
    }

    // MARK: Next round

    @ViewBuilder private func nextRoundSection(_ live: SessionViewDoc) -> some View {
        if live.session.status == .COMPLETED {
            Section {
                NavigationLink { NightSummaryView(sessionId: sessionId) } label: {
                    Label("Night Summary & Scorecard", systemImage: "trophy.fill")
                }
            } header: {
                Text("Night Over")
            }
        } else if let next = live.nextRound {
            Section {
                Label { Text("\(live.session.name(next.suggestedHidingTeam)) \(live.session.verb([next.suggestedHidingTeam], "hides", "hide")) next") } icon: {
                    Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(next.suggestedHidingTeam))
                }
                .font(.headline)
                Button("Someone Else Hides…") { showWhoHides = true }
                Button("Crews & Rules…") { showEdit = true }
                NavigationLink { NightSummaryView(sessionId: sessionId) } label: {
                    Label("Night So Far", systemImage: "list.number")
                }
                Button("End the Night", role: .destructive) { confirmEndNight = true }
            } header: {
                Text("Round \(next.index)")
            }
        }
    }

    private func createNext(hidingTeam: TeamKey?) {
        perform($busy, $error) { _ = try await model.api.nextRound(sessionId, hidingTeam: hidingTeam) }
    }

    private func dispute(_ c: RoundSummary.Claim, accept: Bool) {
        perform($busy, $error) {
            try await model.api.dispute(sessionId, roundId, claimId: c.claimId, accept: accept)
            model.show("Recorded — the other crew must agree")
            await load()
        }
    }
}

/// Every crew's completed route (static polylines with markers). Solid = on foot,
/// dashed = car, so the legend never relies on colour alone.
struct RecapMap: View {
    let summary: RoundSummary
    let routes: RouteRecap?
    var interactive = true

    private var hidingTeam: TeamKey? { summary.hidingTeam }

    var body: some View {
        Map(interactionModes: interactive ? .all : []) {
            if let routes {
                ForEach(Array(routes.teams.values), id: \.team) { team in
                    let color = Theme.crew(team.team)
                    ForEach(Array(team.segments.enumerated()), id: \.offset) { _, seg in
                        if seg.points.count > 1 {
                            MapPolyline(coordinates: seg.points.map(\.coordinate))
                                .stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round, dash: team.role == .SEEKING ? [8, 6] : []))
                        }
                    }
                    if let first = team.segments.first?.points.first {
                        Annotation("\(summary.teamNames[team.team.rawValue] ?? "") start", coordinate: first.coordinate) {
                            Image(systemName: "flag.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(6)
                                .background(color, in: Circle())
                                .overlay(Circle().stroke(.white, lineWidth: 1.5))
                        }
                    }
                }
                if let cp = routes.markers.claimPoint {
                    Annotation("Catch", coordinate: cp.coordinate) {
                        Image(systemName: "camera.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(7)
                            .background(Color.accentColor, in: Circle())
                            .overlay(Circle().stroke(.white, lineWidth: 1.5))
                    }
                }
            }
            ForEach(summary.pings.filter { $0.coordinate != nil }) { p in
                Annotation("Ping \(p.index)", coordinate: p.coordinate!) {
                    Image(systemName: "diamond.fill")
                        .foregroundStyle(hidingTeam.map(Theme.crew) ?? .secondary)
                        .shadow(color: .black.opacity(0.3), radius: 1.5, y: 1)
                }
            }
        }
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
        .overlay(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 4) {
                legend(dash: [], text: "Hiders on foot")
                legend(dash: [5, 4], text: "Seekers by car")
            }
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(10)
            .accessibilityElement(children: .combine)
        }
    }

    private func legend(dash: [CGFloat], text: String) -> some View {
        HStack(spacing: 6) {
            Path { p in p.move(to: CGPoint(x: 0, y: 5)); p.addLine(to: CGPoint(x: 22, y: 5)) }
                .stroke(.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: dash))
                .frame(width: 22, height: 10)
                .accessibilityHidden(true)
            Text(text)
        }
    }
}
