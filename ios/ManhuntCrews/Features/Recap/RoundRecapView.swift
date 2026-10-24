import SwiftUI
import MapKit

/// Post-round recap (spec §6.1, screen 12), story first (ADR 0020):
/// 1. what happened: the outcome, who hid and who sought, and any highlight of the night it set;
/// 2. the catch photo and the map, which replays the round;
/// 3. the numbers that matter, one per tile;
/// 4. between rounds: tonight's rounds so far, and what's next.
/// Pings, GPS quality, pauses, claims and the timeline are one tap away in Round Details.
/// No round winner: catch credit (Together/Race) is attribution only.
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
    /// The night's scorecard, for highlights and tonight's other rounds (optional).
    @State private var night: SessionAnalytics?
    @State private var busy = false
    @State private var error: String?
    @State private var showWhoHides = false
    @State private var showEdit = false
    @State private var confirmEndNight = false
    @State private var showMap = false
    @State private var showPhoto = false
    @State private var showShare = false

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }
    private var isLive: Bool { live != nil }

    var body: some View {
        List {
            if let s = summary, let r = s.result {
                Section { hero(s, r) }
                disputes(s)
                if let photo, r.outcome == "CAUGHT" { catchSection(s, r, photo) }
                mapSection(s)
                numbers(r)
                Section {
                    NavigationLink { RoundDetailsView(summary: s, units: units) } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Round Details")
                                Text("Pings, GPS, pauses, claims and the timeline").font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "list.bullet.rectangle") }
                    }
                    .accessibilityIdentifier("recap.details")
                }
                if isLive { tonight(r) }
            } else {
                Section {
                    HStack { Spacer(); ProgressView("Computing recap…"); Spacer() }
                        .padding(.vertical, 40)
                }
            }
            if let live { nextRoundSection(live) }
        }
        .navigationTitle("Round \(summary?.index ?? live?.round?.index ?? 0)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isLive { ToolbarItem(placement: .cancellationAction) { CloseButton { model.closeSession() } } }
            if summary?.result != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button { showShare = true } label: { Label("Share Round", systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("recap.share")
                }
            }
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
        .sheet(isPresented: $showShare) { shareSheet }
        .fullScreenCover(isPresented: $showMap) {
            if let s = summary {
                NavigationStack {
                    RouteReplayView(summary: s, routes: routes)
                        .ignoresSafeArea(edges: .bottom)
                        .navigationTitle("Round \(s.index)")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { showMap = false } } }
                }
            }
        }
        .fullScreenCover(isPresented: $showPhoto) {
            if let photo { PhotoViewer(image: photo, title: "Round \(summary?.index ?? 0) Catch") { showPhoto = false } }
        }
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
        // Context only: the recap stands on its own if the scorecard can't load.
        night = (try? await model.api.analytics(sessionId)) ?? night
    }

    private var highlights: [NightHighlight] { summary.flatMap { s in night?.scorecard.highlights(in: s.index) } ?? [] }

    // MARK: 1. What happened

    private func hero(_ s: RoundSummary, _ r: RoundResult) -> some View {
        let hideMarks = highlights.contains { $0.kind == .LONGEST_HIDE || $0.kind == .FASTEST_CATCH }
        let rank = hideMarks ? nil : StatsText.hideRank(of: r.roundIndex, in: night?.scorecard.rounds ?? [], live: isLive)
        return VStack(alignment: .leading, spacing: 10) {
            Text(RecapText.headline(r))
                .font(.largeTitle.bold())
                .fontDesign(.rounded)
                .monospacedDigit()
                .accessibilityIdentifier("recap.outcome")
            if let sub = RecapText.subline(r) {
                Text(sub).font(.subheadline).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                Label { Text("\(r.name(r.hidingTeam)) hid") } icon: {
                    Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(r.hidingTeam))
                }
                Label { Text(RecapText.seekersLine(r)) } icon: {
                    Image(systemName: Role.SEEKING.symbol).foregroundStyle((r.catchCreditTeams.first ?? r.seekingTeams.first).map(Theme.crew) ?? .secondary)
                }
            }
            .font(.headline)
            if r.seekingTeams.count > 1 {
                Text(r.seekMode == .RACE ? "Seekers raced: the crew that made the catch gets the credit." : "Seekers hunted together: the catch counts for both crews.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !highlights.isEmpty || rank != nil {
                FlowLayout(spacing: 6) {
                    ForEach(highlights) { HighlightBadge(text: StatsText.badge($0.kind, live: isLive)) }
                    if let rank { HighlightBadge(text: rank, symbol: "chart.bar.fill", tint: .secondary) }
                }
            }
            if r.resolvedByDispute {
                Text("Settled together after the round.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder private func disputes(_ s: RoundSummary) -> some View {
        // Disputes are settled by the hiding crew and the claiming crew; they need an answer, so they come first.
        let disputable = s.claims.filter { c in (c.status == "REJECTED" || c.status == "EXPIRED") && (s.myTeam == s.hidingTeam || s.myTeam == c.team) }
        if !disputable.isEmpty {
            Section {
                ForEach(disputable) { c in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(c.team.map { s.teamNames[$0.rawValue] ?? $0.colourName } ?? "A crew") claimed a catch\(c.chaseSecondsAtClaim.map { " at \(Fmt.clock(Double($0)))" } ?? "") · \(c.status == "EXPIRED" ? "no answer in time" : "rejected")")
                            .font(.subheadline.weight(.semibold))
                        if let reason = c.rejectionReason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                        HStack {
                            Button("Accept as the Catch") { dispute(c, accept: true) }
                            Spacer()
                            Button("Keep Rejected") { dispute(c, accept: false) }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("Settle a Claim")
            } footer: {
                Text("The hiders and the claiming crew can both accept a claim as the catch.")
            }
        }
    }

    // MARK: 2. The catch and the map

    private func catchSection(_ s: RoundSummary, _ r: RoundResult, _ photo: UIImage) -> some View {
        let claim = s.claims.first { $0.status == "CONFIRMED" }
        let by = (claim?.team).map(r.name) ?? r.catchCreditTeams.map(r.name).formatted(.list(type: .and))
        let caption = "\(by)\(claim?.chaseSecondsAtClaim.map { " · \(Fmt.clock(Double($0))) into the chase" } ?? "")"
        return Section {
            Button { showPhoto = true } label: {
                // The frame sets the size; the photo fills it (a scaled-to-fill image would widen the row).
                Color.clear
                    .frame(maxWidth: .infinity)
                    .frame(height: 320)
                    .overlay { Image(uiImage: photo).resizable().scaledToFill() }
                    .clipShape(RoundedRectangle(cornerRadius: Theme.mediaCorner, style: .continuous))
                    .overlay(alignment: .bottomLeading) {
                        Label(caption, systemImage: "camera.fill")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .glassSurface()
                            .padding(10)
                    }
            }
            .buttonStyle(.plain)
            .bareListRow()
            .accessibilityLabel("Catch photo: \(caption)")
            .accessibilityHint("Opens the photo full screen")
        } header: {
            Text("The Catch")
        }
    }

    private func mapSection(_ s: RoundSummary) -> some View {
        Section {
            // A static preview inside the scrolling list (so swipes scroll the page); full screen is interactive.
            Button { showMap = true } label: {
                RecapMap(summary: s, routes: routes, interactive: false)
                    .frame(height: 280)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.mediaCorner, style: .continuous))
                    .overlay(alignment: .topLeading) { RouteLegend(showSeekers: routes != nil).padding(10) }
                    .overlay(alignment: .bottomTrailing) {
                        Label("Replay", systemImage: "play.fill")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .glassSurface()
                            .padding(10)
                    }
            }
            .buttonStyle(.plain)
            .bareListRow()
            .accessibilityLabel("Route map")
            .accessibilityHint("Opens the map full screen, where you can replay the round")
        } header: {
            Text("The Chase")
        } footer: {
            Text(routesError ?? "Each crew’s route from its phone with the best GPS. Circles mark where crews started; the camera marks the catch.")
        }
    }

    // MARK: 3. The numbers

    private func numbers(_ r: RoundResult) -> some View {
        let badge = { (kinds: [NightHighlight.Kind], team: TeamKey) in
            highlights.first { kinds.contains($0.kind) && $0.teams.contains(team) }.map { StatsText.badge($0.kind, live: isLive) }
        }
        let hiders = r.crew(r.hidingTeam)
        return Section("By the Numbers") {
            StatGrid {
                if r.outcome != "ABORTED" {
                    StatTile(label: r.outcome == "CAUGHT" ? "Chase" : "Survived",
                             value: (r.isRightCensored ? "≥ " : "") + Fmt.clock(Double(r.observedChaseSeconds)),
                             detail: "After a \(Fmt.clock(Double(r.headStartSeconds))) head start",
                             symbol: "stopwatch.fill", tint: Theme.crew(r.hidingTeam))
                }
                StatTile(label: "On foot", value: distanceText(hiders), detail: footDetail(r, hiders),
                         symbol: "figure.walk", tint: Theme.crew(r.hidingTeam), badge: badge([.MOST_ON_FOOT, .LEAST_ON_FOOT], r.hidingTeam))
                ForEach(r.seekingTeams) { k in
                    StatTile(label: "By car", value: distanceText(r.crew(k)), detail: "\(r.name(k))\(qualityNote(r.crew(k)))",
                             symbol: "car.fill", tint: Theme.crew(k), badge: badge([.MOST_DRIVING, .LEAST_DRIVING], k))
                }
                StatTile(label: "Pings", value: "\(r.pingsReleased) of \(r.pingSlots)", detail: pingDetail(r),
                         symbol: "diamond.fill", tint: Theme.crew(r.hidingTeam))
                if r.totalPauseSeconds > 0 {
                    StatTile(label: "Paused", value: Fmt.clock(Double(r.totalPauseSeconds)), detail: "Not counted in the chase", symbol: "pause.circle.fill")
                }
                StatTile(label: "Start to finish", value: Fmt.clock(Double(r.roundElapsedSeconds)), detail: "Head start, chase and pauses", symbol: "clock")
            }
            .bareListRow()
        }
    }

    private func distanceText(_ c: CrewRouteStats?) -> String {
        RecapText.distance(c).map { Fmt.distance($0, units: units) } ?? "—"
    }

    private func qualityNote(_ c: CrewRouteStats?) -> String {
        switch c?.routeQuality {
        case "ESTIMATED": " · estimated, patchy GPS"
        case "INSUFFICIENT": " · not enough GPS"
        case nil: " · no GPS"
        default: ""
        }
    }

    private func footDetail(_ r: RoundResult, _ c: CrewRouteStats?) -> String {
        let chase = RecapText.distance(c, chaseOnly: true).map { " · \(Fmt.distance($0, units: units)) in the chase" } ?? ""
        return "\(r.name(r.hidingTeam))\(chase)\(qualityNote(c))"
    }

    private func pingDetail(_ r: RoundResult) -> String {
        var parts: [String] = []
        if r.pingsMissing > 0 { parts.append("\(r.pingsMissing) missed") }
        if r.pingsDelayed > 0 { parts.append("\(r.pingsDelayed) late") }
        if r.pingSlots == 0 { return "None were due" }
        return parts.isEmpty ? "All on time" : parts.joined(separator: " · ")
    }

    // MARK: 4. Tonight and what's next

    private func tonight(_ r: RoundResult) -> some View {
        Section {
            if let rounds = night?.scorecard.rounds, rounds.count > 1 {
                let longest = rounds.filter { $0.outcome != "ABORTED" }.map(\.observedChaseSeconds).max() ?? 0
                ForEach(rounds, id: \.roundId) { other in
                    if other.roundIndex == r.roundIndex {
                        RoundBarRow(round: other, longest: longest, highlighted: true)
                    } else {
                        NavigationLink { RoundRecapView(sessionId: sessionId, roundId: other.roundId) } label: {
                            RoundBarRow(round: other, longest: longest)
                        }
                    }
                }
            }
            NavigationLink { NightSummaryView(sessionId: sessionId) } label: {
                Label("Night So Far", systemImage: "trophy")
            }
        } header: {
            Text("Tonight")
        }
    }

    @ViewBuilder private func nextRoundSection(_ live: SessionViewDoc) -> some View {
        if live.session.status == .COMPLETED {
            Section {
                NavigationLink { NightSummaryView(sessionId: sessionId) } label: {
                    Label("The Night’s Results", systemImage: "trophy.fill")
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
                Button("End the Night", role: .destructive) { confirmEndNight = true }
            } header: {
                Text("Up Next: Round \(next.index)")
            }
        }
    }

    // MARK: Sharing

    @ViewBuilder private var shareSheet: some View {
        if let s = summary, let r = s.result {
            let date = (s.endedAt ?? s.roundStartAt)?.formatted(date: .abbreviated, time: .omitted) ?? ""
            let marks = highlights
            let routes = self.routes
            let photo = r.outcome == "CAUGHT" ? self.photo : nil
            let options = [ShareCardSheet.Option(id: "round", title: "Round")] + (photo == nil ? [] : [.init(id: "photo", title: "Catch Photo")])
            ShareCardSheet(title: "Share Round \(r.roundIndex)", options: options) { option in
                if option.id == "photo", let photo { return ShareCardRenderer.image(CatchShareCard(photo: photo, result: r, date: date)) }
                let map = await RouteSnapshot.render(summary: s, routes: routes, size: CGSize(width: 316, height: 170))
                return ShareCardRenderer.image(RoundShareCard(result: r, map: map, highlights: marks, units: units, date: date))
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

/// A photo full screen, on black, with Close.
struct PhotoViewer: View {
    let image: UIImage
    let title: String
    let close: () -> Void

    var body: some View {
        NavigationStack {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black.ignoresSafeArea())
                .accessibilityLabel("Catch photo")
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton(action: close) } }
        }
    }
}
