import SwiftUI

/// The night (spec §6.2), one page from History, "Night so far" and the end of a night (ADR 0020):
/// 1. the verdict: a stronger hiding crew only when the comparison is fair, else why not, calmly;
/// 2. highlights: the night's single-round records, each a tap from its round;
/// 3. rounds, each with a bar as long as its chase time;
/// 4. the night map, crews (compared only within a line-up, ADR 0019) and people (crew-level);
/// 5. exporting under Export Data, and deleting in the toolbar menu (from History).
struct NightSummaryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    /// From History: adds Open Night and the delete actions.
    var item: SessionListItem?
    @State private var data: SessionAnalytics?
    @State private var error: String?
    @State private var showShare = false
    @State private var confirmDelete = false
    @State private var confirmMyData = false
    @State private var busy = false
    @State private var openRound: RoundLink?

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }

    var body: some View {
        List {
            if let d = data {
                Section { header(d) }
                highlights(d)
                rounds(d)
                if !d.scorecard.rounds.isEmpty {
                    Section {
                        NavigationLink { NightMapView(sessionId: sessionId, rounds: d.scorecard.rounds) } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Night Map")
                                    Text("Every round, where it started and ended").font(.footnote).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: "map") }
                        }
                        .accessibilityIdentifier("night.map")
                    }
                }
                crews(d)
                if let people = d.scorecard.people, !people.isEmpty {
                    NightPeopleSection(sessionId: sessionId, people: people, rounds: d.scorecard.rounds, units: units)
                }
                Section {
                    NavigationLink { NightDataView(sessionId: sessionId) } label: {
                        Label("Export Data", systemImage: "square.and.arrow.down")
                    }
                }
            } else {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 40)
                }
            }
        }
        .navigationTitle(data?.title ?? item?.title ?? "Night")
        .navigationSubtitleCompat((data?.scheduledDate ?? item?.scheduledDate).map(Fmt.day))
        .toolbar {
            if let item, item.status != .COMPLETED {
                ToolbarItem(placement: .primaryAction) {
                    Button { model.openSession(item.id) } label: { Label("Open Night", systemImage: "play.circle.fill") }
                }
            }
            if let d = data, !d.scorecard.rounds.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button { showShare = true } label: { Label("Share Night", systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("night.share")
                }
            }
            if let item {
                ToolbarItem(placement: .secondaryAction) {
                    Button("Delete My Data…", systemImage: "location.slash", role: .destructive) { confirmMyData = true }
                }
                if item.isHost {
                    ToolbarItem(placement: .secondaryAction) {
                        Button("Delete Night for Everyone…", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    }
                }
            }
        }
        .navigationDestination(item: $openRound) { RoundRecapView(sessionId: sessionId, roundId: $0.roundId) }
        .sheet(isPresented: $showShare) { shareSheet }
        .confirmationDialog("Delete your tracks and photos?", isPresented: $confirmMyData, titleVisibility: .visible) {
            Button("Delete My Data", role: .destructive) {
                perform($busy, $error) {
                    let r = try await model.api.deleteMyData(sessionId)
                    model.show("Deleted \(r.pointsDeleted) GPS points and \(r.photosDeleted) photos")
                }
            }
        } message: { Text("Removes this phone’s routes, raw GPS and photos from this night. Crew scores stay. This can’t be undone.") }
        .confirmationDialog("Delete the whole night?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Night", role: .destructive) {
                perform($busy, $error) {
                    try await model.api.deleteSession(sessionId)
                    dismiss()
                }
            }
        } message: { Text("Removes every round, route and photo of this night for every phone. This can’t be undone.") }
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($error)
    }

    private func load() async {
        do { data = try await model.api.analytics(sessionId) } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    // MARK: Verdict

    private func verdict(_ d: SessionAnalytics) -> StatsText.Verdict {
        let first = d.scorecard.matchups?.first
        let comparison = d.scorecard.matchups?.count == 1 ? first!.comparison : d.scorecard.comparison
        return StatsText.verdict(comparison, matchups: d.scorecard.matchups?.count ?? 1) { k in
            first?.crews.first { $0.team == k }?.name ?? d.teams[k.rawValue]?.name ?? k.colourName
        }
    }

    private func header(_ d: SessionAnalytics) -> some View {
        let v = verdict(d)
        let people = Set(d.scorecard.rounds.flatMap { $0.rosterSnapshot.values.flatMap { $0.map(\.personId) } }).count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("\(d.playedRounds) \(d.playedRounds == 1 ? "round" : "rounds")\(people > 0 ? " · \(people) people" : "")")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                if d.status != .COMPLETED { StatusBadge(text: "In progress", systemImage: "circle.dotted", tint: Theme.ok) }
            }
            Label { Text(v.title) } icon: {
                Image(systemName: v.symbol).foregroundStyle(v.crew.map(Theme.crew) ?? .secondary)
            }
            .font(.title2.bold())
            .accessibilityIdentifier("night.verdict")
            Text(v.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    // MARK: Highlights

    @ViewBuilder private func highlights(_ d: SessionAnalytics) -> some View {
        if let hs = d.scorecard.highlights, !hs.isEmpty {
            Section {
                // Buttons, not NavigationLinks: a link in a List row adds a chevron beside every card.
                StatGrid {
                    ForEach(hs) { h in
                        if let r = d.scorecard.rounds.first(where: { $0.roundIndex == h.roundIndex }) {
                            Button { openRound = RoundLink(roundId: r.roundId) } label: {
                                HighlightCard(highlight: h, units: units, tappable: true)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens round \(h.roundIndex)")
                        }
                    }
                }
                .bareListRow()
            } header: {
                Text("Highlights")
            } footer: {
                Text("The night’s single-round records. Each belongs to one round, not to the whole night.")
            }
        }
    }

    // MARK: Rounds

    private func rounds(_ d: SessionAnalytics) -> some View {
        let longest = d.scorecard.rounds.filter { $0.outcome != "ABORTED" }.map(\.observedChaseSeconds).max() ?? 0
        return Section {
            ForEach(d.scorecard.rounds, id: \.roundId) { r in
                NavigationLink { RoundRecapView(sessionId: sessionId, roundId: r.roundId) } label: {
                    RoundBarRow(round: r, longest: longest, note: d.scorecard.changes(before: r.roundIndex).flatMap { $0.isEmpty ? nil : ChangeText.describe($0) })
                }
            }
            if d.scorecard.rounds.isEmpty { Text("No finished rounds yet.").foregroundStyle(.secondary) }
        } header: {
            Text("Rounds")
        } footer: {
            if !d.scorecard.rounds.isEmpty {
                Text("Each bar is the chase time, in the colour of the crew that hid.\(d.scorecard.rounds.contains(where: \.isRightCensored) ? " ≥ means never caught: the round hit its time limit." : "")")
            }
        }
    }

    // MARK: Crews

    @ViewBuilder private func crews(_ d: SessionAnalytics) -> some View {
        if let matchups = d.scorecard.matchups {
            if matchups.count == 1, let m = matchups.first {
                Section {
                    ForEach(m.crews) { MatchupCrewRow(crew: $0, matchup: m, units: units) }
                } header: {
                    Text("Crews")
                } footer: {
                    if m.crews.count > 1 { Text(StatsText.comparisonNote(m.comparison)) }
                }
            } else if matchups.count > 1 {
                Section {
                    NavigationLink { MatchupsView(matchups: matchups, units: units) } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Crews")
                                Text("\(matchups.count) line-ups, each compared on its own").font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "person.3") }
                    }
                }
            }
        } else {
            // A server from before matchups: totals per crew colour.
            ForEach(TeamKey.allCases) { k in
                if let t = d.scorecard.teams[k.rawValue] { LegacyTeamSection(key: k, score: t, roster: d.teams[k.rawValue]?.roster ?? [], units: units) }
            }
        }
    }

    // MARK: Share

    @ViewBuilder private var shareSheet: some View {
        if let d = data {
            let v = verdict(d)
            let card = NightShareCard(title: d.title, date: Fmt.day(d.scheduledDate), verdict: v, highlights: d.scorecard.highlights ?? [], rounds: d.scorecard.rounds, units: units)
            ShareCardSheet(title: "Share Night", options: [.init(id: "night", title: "Night")]) { _ in ShareCardRenderer.image(card) }
        }
    }
}

/// A round to open from a card (navigation by value).
struct RoundLink: Hashable, Identifiable {
    let roundId: String
    var id: String { roundId }
}

/// "Sam → Blue crew · Ezra joined · Theo left · Head start 10 → 5 min": what changed before a round.
enum ChangeText {
    static func describe(_ c: RoundChanges) -> String {
        var parts = c.moved.map { "\($0.name) → \($0.to.colourName)" }
        if !c.joined.isEmpty { parts.append("\(c.joined.formatted(.list(type: .and))) joined") }
        if !c.left.isEmpty { parts.append("\(c.left.formatted(.list(type: .and))) out") }
        parts += c.rules.map(rule)
        return parts.joined(separator: " · ")
    }

    static func rule(_ r: RoundChanges.RuleChange) -> String {
        let minutes = { (d: RoundSummary.TimelineEvent.Detail) in d.int.map { "\($0 / 60) min" } }
        switch r.field {
        case "headStartSeconds": return "Head start \(minutes(r.from) ?? "?") → \(minutes(r.to) ?? "?")"
        case "pingIntervalSeconds": return "Pings every \(minutes(r.from) ?? "?") → \(minutes(r.to) ?? "?")"
        case "maxChaseSeconds": return "Chase cap \(minutes(r.from) ?? "none") → \(minutes(r.to) ?? "none")"
        case "visiblePingHistoryCount":
            let pins = { (d: RoundSummary.TimelineEvent.Detail) in d.int.map { $0 == 1 ? "last pin" : "last \($0) pins" } ?? "all pins" }
            return "Showing \(pins(r.from)) → \(pins(r.to))"
        case "confirmationTimeoutSeconds": return "Time to confirm \(r.from.int.map { "\($0) s" } ?? "?") → \(r.to.int.map { "\($0) s" } ?? "?")"
        case "manualPausesEnabled": return r.to.isTrue ? "Pauses allowed" : "Pauses off"
        case "maxPingGpsAgeSeconds": return "Oldest GPS fix \(r.from.int.map { "\($0) s" } ?? "?") → \(r.to.int.map { "\($0) s" } ?? "?")"
        case "maxPingAccuracyMeters": return "GPS accuracy \(r.from.int.map { "\($0) m" } ?? "?") → \(r.to.int.map { "\($0) m" } ?? "?")"
        case "seekMode": return r.to.string == "RACE" ? "Seekers race" : "Seekers together"
        default: return "Rules changed"
        }
    }
}
