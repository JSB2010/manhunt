import SwiftUI
import Charts

/// Night scorecard (spec §6.2). Crews change during a night (ADR 0019), so crews are compared only
/// within a matchup: rounds with the same people on each crew under the same rules. Each person's
/// tally is their crews' results, never individual performance. Catch credit (Together/Race) is
/// attribution, never a winner; timed-out rounds are flagged, never counted as catches.
struct NightSummaryView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    @State private var data: SessionAnalytics?
    @State private var error: String?
    @State private var exportURL: URL?
    @State private var busy = false

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }

    var body: some View {
        List {
            if let d = data {
                Section { headline(d) }
                if let matchups = d.scorecard.matchups {
                    ForEach(matchups) { matchupSection($0) }
                    if let people = d.scorecard.people, !people.isEmpty { peopleSection(people) }
                } else {
                    // A server from before matchups: totals per crew colour.
                    ForEach(TeamKey.allCases) { k in
                        if let t = d.scorecard.teams[k.rawValue] { teamSection(k, t, roster: d.teams[k.rawValue]?.roster ?? []) }
                    }
                }
                Section("Chase Time by Round") { trend(d) }
                roundsSection(d)
                Section {
                    Button { export("csv") } label: { Label("Export CSV", systemImage: "tablecells") }
                    Button { export("json") } label: { Label("Export JSON", systemImage: "curlybraces") }
                    if let exportURL {
                        ShareLink(item: exportURL) { Label("Share \(exportURL.pathExtension.uppercased()) File", systemImage: "square.and.arrow.up") }
                    }
                } header: {
                    Text("Export")
                } footer: {
                    Text("No GPS coordinates are exported.")
                }
            } else {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 40)
                }
            }
        }
        .navigationTitle("Night Summary")
        .navigationSubtitleCompat(data.map { "\($0.title) · \(Fmt.day($0.scheduledDate))" })
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($error)
    }

    private func load() async {
        do { data = try await model.api.analytics(sessionId) } catch { self.error = error.localizedDescription }
    }

    // MARK: Headline

    @ViewBuilder private func headline(_ d: SessionAnalytics) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let m = d.scorecard.matchups, m.count > 1 {
                Label("Crews Changed During the Night", systemImage: "arrow.triangle.swap").font(.title3.bold())
                Text("Crews are compared only over rounds they played with the same people and rules: \(m.count) matchups below.")
                    .font(.subheadline)
            } else {
                comparison(d.scorecard.matchups?.first?.comparison ?? d.scorecard.comparison, name: { k in
                    d.scorecard.matchups?.first?.crews.first { $0.team == k }?.name ?? d.teams[k.rawValue]?.name ?? k.colourName
                })
            }
            Text("\(d.playedRounds) \(d.playedRounds == 1 ? "round" : "rounds") played.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func comparison(_ c: NightComparison, name: (TeamKey) -> String) -> some View {
        switch c.status {
        case "COMPARABLE":
            if let k = c.strongerHidingTeam {
                Label { Text("\(name(k)) lasted longest while hiding") } icon: {
                    Image(systemName: "medal.fill").foregroundStyle(Theme.crew(k))
                }
                .font(.title3.bold())
                if let m = c.marginSeconds { Text("by \(Fmt.clock(Double(m))) on average").font(.headline).monospacedDigit() }
            } else {
                Label("Evenly Matched", systemImage: "equal.circle.fill").font(.title3.bold())
            }
        case "PROVISIONAL":
            Label { Text("Provisional Comparison") } icon: {
                Image(systemName: "exclamationmark.bubble.fill").foregroundStyle(Theme.warning)
            }
            .font(.title3.bold())
        default:
            Label("Not Enough Rounds to Compare", systemImage: "hourglass").font(.title3.bold())
        }
        Text(c.explanation).font(.subheadline)
    }

    // MARK: Matchups and people

    private func matchupSection(_ m: Matchup) -> some View {
        Section {
            ForEach(m.crews) { c in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        CrewDot(key: c.team)
                        Text(c.name).font(.headline)
                        if m.comparison.status == "COMPARABLE" && m.comparison.strongerHidingTeam == c.team {
                            Image(systemName: "medal.fill").foregroundStyle(Theme.crew(c.team)).accessibilityLabel("Lasted longest while hiding")
                        }
                    }
                    if !c.people.isEmpty && !CrewNames.nameListsEveryone(c.name, people: c.people, key: c.team) {
                        Text(c.people.map(\.displayName).formatted(.list(type: .and))).font(.subheadline)
                    }
                    Text(crewLine(c)).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text(m.title)
        } footer: {
            if m.crews.count > 1 { Text(m.comparison.explanation) }
        }
    }

    private func crewLine(_ c: Matchup.Crew) -> String {
        var parts: [String] = []
        if c.hideRounds > 0 {
            let avg = c.hideAverageSeconds.map { (c.hideIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—"
            parts.append("Hid \(times(c.hideRounds)), lasted \(avg)\(c.hideRounds > 1 ? " on average" : "")")
            if c.hiderFootMeters > 0 { parts.append("\(Fmt.distance(c.hiderFootMeters, units: units)) on foot") }
        }
        if c.seekRounds > 0 {
            parts.append("Sought \(times(c.seekRounds)), \(c.catches == 1 ? "1 catch" : "\(c.catches) catches")")
            if c.seekerVehicleMeters > 0 { parts.append("\(Fmt.distance(c.seekerVehicleMeters, units: units)) by car") }
        }
        return parts.joined(separator: " · ")
    }

    private func times(_ n: Int) -> String { n == 1 ? "once" : n == 2 ? "twice" : "\(n) times" }

    private func peopleSection(_ people: [PersonNightStats]) -> some View {
        Section {
            ForEach(people) { p in
                LabeledContent {
                    Text(p.hideAverageSeconds.map { (p.hideIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—")
                        .monospacedDigit()
                } label: {
                    Text(p.displayName)
                    Text("Hid \(p.roundsHid) · sought \(p.roundsSought) · \(p.catches == 1 ? "1 catch" : "\(p.catches) catches")")
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("People")
        } footer: {
            Text("Each person gets their crew’s results: how long the crew lasted while they hid with it, and the catches it made while they sought. Crew results, not individual performance.")
        }
    }

    /// Fallback for servers without matchups: totals per crew colour.
    private func teamSection(_ k: TeamKey, _ t: TeamScore, roster: [PersonRef]) -> some View {
        Section {
            LabeledContent("Rounds hidden", value: "\(t.hideRoundCount)")
            LabeledContent("Average survival", value: t.hideSurvivalAverageSeconds.map { (t.hideSurvivalAverageIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("Caught / not caught", value: "\(t.caughtCount) / \(t.uncaughtCount)")
            LabeledContent("Average time to find", value: t.seekCaptureAverageSeconds.map { Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("On foot (hiding)", value: Fmt.distance(t.hiderFootMetersTotal, units: units))
            LabeledContent("By car (seeking)", value: Fmt.distance(t.seekerVehicleMetersChase, units: units))
        } header: {
            HStack(spacing: 8) {
                CrewDot(key: k)
                Text(t.name)
            }
        } footer: {
            if !roster.isEmpty { Text(roster.map(\.displayName).formatted(.list(type: .and))) }
        }
        .monospacedDigit()
    }

    // MARK: Rounds

    private func trend(_ d: SessionAnalytics) -> some View {
        Chart(d.scorecard.trend) { t in
            let hiders = d.scorecard.rounds.first { $0.roundIndex == t.roundIndex }.map { $0.name($0.hidingTeam) } ?? t.hidingTeam.colourName
            BarMark(x: .value("Round", "R\(t.roundIndex)"), y: .value("Minutes", Double(t.observedChaseSeconds) / 60))
                // Colour is the hiding crew's colour that round; the people behind it can change between rounds.
                .foregroundStyle(Theme.crew(t.hidingTeam))
                .annotation(position: .top) {
                    Text(t.outcome == "ABORTED" ? "aborted" : (t.isRightCensored ? "≥" : "") + Fmt.clock(Double(t.observedChaseSeconds)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .opacity(t.outcome == "ABORTED" ? 0.3 : 1)
                .accessibilityLabel("Round \(t.roundIndex), \(hiders) hid")
                .accessibilityValue(t.outcome == "ABORTED" ? "aborted" : (t.isRightCensored ? "at least " : "") + Fmt.spokenDuration(Double(t.observedChaseSeconds)))
        }
        .chartYAxisLabel("Minutes")
        .frame(height: 200)
        .padding(.vertical, 8)
    }

    private func roundsSection(_ d: SessionAnalytics) -> some View {
        Section("Rounds") {
            ForEach(d.scorecard.rounds, id: \.roundId) { r in
                VStack(alignment: .leading, spacing: 4) {
                    LabeledContent {
                        Text(Fmt.outcome(r.outcome, seconds: r.observedChaseSeconds)).monospacedDigit()
                    } label: {
                        Text("Round \(r.roundIndex)")
                        Text("\(r.name(r.hidingTeam)) hid\(r.seekMode == .RACE && !r.catchCreditTeams.isEmpty ? " · \(r.catchCreditTeams.map(r.name).joined(separator: ", ")) caught" : "")")
                    }
                    if let c = d.scorecard.changes(before: r.roundIndex), !c.isEmpty {
                        Label { Text(ChangeText.describe(c)) } icon: { Image(systemName: "arrow.triangle.swap") }
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func export(_ format: String) {
        perform($busy, $error) {
            let data = try await model.api.export(sessionId, format: format)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("manhunt-\(sessionId).\(format)")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            exportURL = url
        }
    }
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
