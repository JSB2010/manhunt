import SwiftUI
import Charts

/// Night scorecard (spec §6.2): crew averages over rounds each crew hid, censored
/// flags, separate walking/driving distances, provisional comparisons, trend.
struct NightSummaryView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    @State private var data: SessionAnalytics?
    @State private var error: String?
    @State private var exportURL: URL?
    @State private var busy = false

    private var units: String { model.me?.profile.preferences.units ?? "MILES" }

    var body: some View {
        ScrollView {
            if let d = data {
                VStack(alignment: .leading, spacing: 16) {
                    Text("\(d.title) · \(d.scheduledDate)").font(.headline).foregroundStyle(.secondary)
                    comparison(d)
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(TeamKey.allCases) { k in
                            if let t = d.scorecard.teams[k.rawValue] { teamCard(t, color: Color(hex: d.teams[k.rawValue]?.color ?? "#888888"), roster: d.teams[k.rawValue]?.roster ?? []) }
                        }
                    }
                    trend(d)
                    roundsTable(d)
                    if d.notDirectlyComparable {
                        Label("Rules changed during the night — rounds are not directly comparable.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                    }
                    HStack {
                        Button("Export CSV") { export("csv") }
                        Button("Export JSON") { export("json") }
                        if let exportURL { ShareLink(item: exportURL) { Label("Share", systemImage: "square.and.arrow.up") } }
                    }
                    .buttonStyle(.bordered)
                    Text("Exports contain scores, crew names and rosters — never GPS coordinates.").font(.caption).foregroundStyle(.secondary)
                }
                .padding()
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            }
        }
        .navigationTitle("Night summary")
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($error)
    }

    private func load() async {
        do { data = try await model.api.analytics(sessionId) } catch { self.error = error.localizedDescription }
    }

    private func comparison(_ d: SessionAnalytics) -> some View {
        let c = d.scorecard.comparison
        return Card {
            switch c.status {
            case "COMPARABLE":
                if let k = c.strongerHidingTeam, let name = d.teams[k.rawValue]?.name {
                    Label("\(name) survived longer while hiding", systemImage: "medal.fill").font(.title3.bold())
                    if let m = c.marginSeconds { Text("by \(Fmt.clock(Double(m))) on average").font(.callout) }
                } else {
                    Label("Evenly matched", systemImage: "equal.circle.fill").font(.title3.bold())
                }
            case "PROVISIONAL":
                Label("Provisional comparison", systemImage: "exclamationmark.bubble.fill").font(.title3.bold()).foregroundStyle(.orange)
            default:
                Label("Not enough rounds to compare", systemImage: "hourglass").font(.title3.bold())
            }
            Text(c.explanation).font(.callout)
            Text("\(d.playedRounds) of \(d.plannedRounds) rounds played. Longer average survival while hiding means the other crew took longer to find them.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func teamCard(_ t: TeamScore, color: Color, roster: [PersonRef]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack { Circle().fill(color).frame(width: 10, height: 10); Text(t.name).font(.headline) }
            Text(roster.map(\.displayName).joined(separator: ", ")).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            Divider()
            LabeledContent("Hid", value: "\(t.hideRoundCount)×")
            LabeledContent("Avg survival", value: t.hideSurvivalAverageSeconds.map { (t.hideSurvivalAverageIncludesCensored ? "≥" : "") + Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("Caught / not", value: "\(t.caughtCount) / \(t.uncaughtCount)")
            LabeledContent("Avg to find", value: t.seekCaptureAverageSeconds.map { Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("On foot", value: Fmt.distance(t.hiderFootMetersTotal, units: units))
            LabeledContent("By car", value: Fmt.distance(t.seekerVehicleMetersChase, units: units))
        }
        .font(.caption)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private func trend(_ d: SessionAnalytics) -> some View {
        VStack(alignment: .leading) {
            Text("Chase time by round").font(.headline)
            Chart(d.scorecard.trend) { t in
                BarMark(x: .value("Round", "R\(t.roundIndex)"), y: .value("Minutes", Double(t.observedChaseSeconds) / 60))
                    .foregroundStyle(by: .value("Hiding crew", d.teams[t.hidingTeam.rawValue]?.name ?? t.hidingTeam.rawValue))
                    .annotation(position: .top) {
                        Text(t.outcome == "ABORTED" ? "aborted" : (t.isRightCensored ? "≥" : "") + Fmt.clock(Double(t.observedChaseSeconds))).font(.caption2)
                    }
                    .opacity(t.outcome == "ABORTED" ? 0.3 : 1)
            }
            .chartForegroundStyleScale(domain: TeamKey.allCases.map { d.teams[$0.rawValue]?.name ?? $0.rawValue },
                                       range: TeamKey.allCases.map { Color(hex: d.teams[$0.rawValue]?.color ?? "#888888") })
            .frame(height: 180)
        }
    }

    private func roundsTable(_ d: SessionAnalytics) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Rounds").font(.headline)
            ForEach(d.scorecard.rounds, id: \.roundId) { r in
                HStack {
                    Text("R\(r.roundIndex)").bold()
                    Text("\(r.hidingTeamName) hid")
                    Spacer()
                    Text(r.outcome == "CAUGHT" ? Fmt.clock(Double(r.observedChaseSeconds)) : r.outcome == "TIMED_OUT" ? "≥ \(Fmt.clock(Double(r.observedChaseSeconds)))" : "aborted")
                        .monospacedDigit()
                }
                .font(.callout)
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
