import SwiftUI
import Charts

/// Night scorecard (spec §6.2): crew averages over rounds each crew hid, censored
/// flags, separate walking/driving distances, provisional comparisons, trend.
/// Two or three crews; catch credit (Together/Race) is attribution, never a winner.
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
                Section { comparison(d) }
                ForEach(TeamKey.allCases) { k in
                    if let t = d.scorecard.teams[k.rawValue] {
                        teamSection(k, t, roster: d.teams[k.rawValue]?.roster ?? [])
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

    @ViewBuilder private func comparison(_ d: SessionAnalytics) -> some View {
        let c = d.scorecard.comparison
        VStack(alignment: .leading, spacing: 8) {
            switch c.status {
            case "COMPARABLE":
                if let k = c.strongerHidingTeam, let name = d.teams[k.rawValue]?.name {
                    Label { Text("\(name) lasted longest while hiding") } icon: {
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
            Text("\(d.playedRounds) \(d.playedRounds == 1 ? "round" : "rounds") played.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func teamSection(_ k: TeamKey, _ t: TeamScore, roster: [PersonRef]) -> some View {
        Section {
            LabeledContent("Rounds hidden", value: "\(t.hideRoundCount)")
            LabeledContent("Average survival", value: t.hideSurvivalAverageSeconds.map { (t.hideSurvivalAverageIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("Caught / not caught", value: "\(t.caughtCount) / \(t.uncaughtCount)")
            LabeledContent("Average time to find", value: t.seekCaptureAverageSeconds.map { Fmt.clock(Double($0)) } ?? "—")
            if t.seekCaughtByOtherCrew > 0 {
                LabeledContent("Beaten to the catch", value: "\(t.seekCaughtByOtherCrew)")
            }
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

    private func trend(_ d: SessionAnalytics) -> some View {
        Chart(d.scorecard.trend) { t in
            BarMark(x: .value("Round", "R\(t.roundIndex)"), y: .value("Minutes", Double(t.observedChaseSeconds) / 60))
                .foregroundStyle(by: .value("Hiding crew", d.teams[t.hidingTeam.rawValue]?.name ?? t.hidingTeam.rawValue))
                .annotation(position: .top) {
                    Text(t.outcome == "ABORTED" ? "aborted" : (t.isRightCensored ? "≥" : "") + Fmt.clock(Double(t.observedChaseSeconds)))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .opacity(t.outcome == "ABORTED" ? 0.3 : 1)
                .accessibilityLabel("Round \(t.roundIndex), \(d.teams[t.hidingTeam.rawValue]?.name ?? "") hid")
                .accessibilityValue(t.outcome == "ABORTED" ? "aborted" : (t.isRightCensored ? "at least " : "") + Fmt.spokenDuration(Double(t.observedChaseSeconds)))
        }
        .chartForegroundStyleScale(domain: chartCrews(d).map { d.teams[$0.rawValue]?.name ?? $0.rawValue },
                                   range: chartCrews(d).map(Theme.crew))
        .chartYAxisLabel("Minutes")
        .frame(height: 200)
        .padding(.vertical, 8)
    }

    /// Crews in the scorecard (a crew removed mid-night still has its rounds).
    private func chartCrews(_ d: SessionAnalytics) -> [TeamKey] {
        TeamKey.allCases.filter { d.teams[$0.rawValue] != nil || d.scorecard.teams[$0.rawValue] != nil }
    }

    private func roundsSection(_ d: SessionAnalytics) -> some View {
        Section("Rounds") {
            ForEach(d.scorecard.rounds, id: \.roundId) { r in
                LabeledContent {
                    Text(Fmt.outcome(r.outcome, seconds: r.observedChaseSeconds)).monospacedDigit()
                } label: {
                    Text("Round \(r.roundIndex)")
                    Text("\(r.name(r.hidingTeam)) hid\(r.seekMode == .RACE && !r.catchCreditTeams.isEmpty ? " · \(r.catchCreditTeams.map(r.name).joined(separator: ", ")) caught" : "")")
                }
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
