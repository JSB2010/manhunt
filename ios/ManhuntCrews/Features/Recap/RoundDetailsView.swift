import SwiftUI

/// Everything about a round that isn't the story (ADR 0020): exact times, each ping, GPS quality per
/// crew, every catch claim and the timeline. For the curious and for settling arguments.
struct RoundDetailsView: View {
    let summary: RoundSummary
    let units: String

    private var r: RoundResult? { summary.result }
    private func name(_ k: TeamKey) -> String { summary.teamNames[k.rawValue] ?? k.colourName }

    var body: some View {
        List {
            if let r { times(r) }
            pings
            if let r { gps(r) }
            claims
            timeline
        }
        .navigationTitle("Round \(summary.index) Details")
        .navigationBarTitleDisplayMode(.inline)
        .monospacedDigit()
    }

    private func times(_ r: RoundResult) -> some View {
        Section {
            LabeledContent("Head start", value: Fmt.clock(Double(r.headStartSeconds)))
            LabeledContent(r.outcome == "CAUGHT" ? "Chase (official)" : "Chase", value: (r.isRightCensored ? "≥ " : "") + Fmt.clock(Double(r.observedChaseSeconds)))
            LabeledContent("Paused", value: Fmt.clock(Double(r.totalPauseSeconds)))
            LabeledContent("Start to finish", value: Fmt.clock(Double(r.roundElapsedSeconds)))
            LabeledContent("Started", value: Fmt.time(summary.roundStartAt))
            LabeledContent("Chase began", value: Fmt.time(summary.chaseStartAt))
            LabeledContent("Ended", value: Fmt.time(summary.endedAt))
            ForEach(Array(summary.pauses.enumerated()), id: \.offset) { _, p in
                LabeledContent {
                    Text(p.endAt.flatMap { end in p.startAt.map { Fmt.clock(end.timeIntervalSince($0)) } } ?? "—")
                } label: {
                    Text(p.kind == "SAFETY" ? "Safety pause" : p.kind == "CAPTURE" ? "Catch review" : "Pause")
                    if let reason = p.reason { Text(reason) }
                }
            }
        } header: {
            Text("Time")
        } footer: {
            Text("The official chase time leaves out pauses and the time a catch was under review.")
        }
    }

    private var pings: some View {
        Section("Pings") {
            ForEach(summary.pings) { p in
                HStack(spacing: 12) {
                    Image(systemName: p.status == "RELEASED" ? "diamond.fill" : "location.slash.fill")
                        .foregroundStyle(p.status == "RELEASED" ? AnyShapeStyle(Theme.crew(summary.hidingTeam)) : AnyShapeStyle(Theme.warning))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ping \(p.index) · \(Fmt.time(p.scheduledAt))")
                        Text(p.status == "RELEASED" ? "GPS fix \(p.ageSeconds ?? 0)s old · ±\(Int(p.accuracyMeters ?? 0)) m\(p.delayed ? " · released late" : "")" : "No GPS got through — not revealed")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if summary.pings.isEmpty { Text("No pings were due.").foregroundStyle(.secondary) }
        }
    }

    private func gps(_ r: RoundResult) -> some View {
        Section {
            ForEach([r.hidingTeam] + r.seekingTeams, id: \.self) { k in
                if let c = r.crew(k) {
                    LabeledContent {
                        Text(Fmt.percent(c.gpsCoverageFraction))
                    } label: {
                        HStack(spacing: 6) {
                            CrewDot(key: k)
                            Text(name(k))
                        }
                        Text("\(c.role == .HIDING ? "Hiding" : "Seeking") · \(quality(c.routeQuality)) · \(c.phones == 1 ? "1 phone" : "\(c.phones) phones")")
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("GPS Coverage")
        } footer: {
            Text("A crew’s route and distance come from its phone with the best GPS; phones are never averaged. Coverage is how much of the round that phone recorded without a gap.")
        }
    }

    private func quality(_ q: String) -> String {
        switch q {
        case "GOOD": "good GPS"
        case "ESTIMATED": "estimated from patchy GPS"
        case "DELETED": "route deleted"
        default: "not enough GPS"
        }
    }

    @ViewBuilder private var claims: some View {
        if !summary.claims.isEmpty {
            Section("Catch Claims") {
                ForEach(summary.claims) { c in
                    LabeledContent {
                        if let t = c.chaseSecondsAtClaim { Text(Fmt.clock(Double(t))) }
                    } label: {
                        Text("\(c.team.map(name) ?? "A crew") · \(Fmt.time(c.submittedAt))")
                        Text(status(c.status) + (c.rejectionReason.map { ": \($0)" } ?? ""))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func status(_ s: String) -> String {
        switch s {
        case "CONFIRMED": "Confirmed"
        case "REJECTED": "Rejected"
        case "EXPIRED": "No answer in time"
        case "PENDING": "Under review"
        default: s.capitalized
        }
    }

    private var timeline: some View {
        // The round itself: recaps from before 2026-10-23 also listed the lobby before it.
        let events = summary.timeline.filter { !RoundSummary.TimelineEvent.lobbyTypes.contains($0.type) && ($0.at ?? .distantFuture) >= (summary.roundStartAt ?? .distantPast) }
        return Section("Timeline") {
            ForEach(events) { e in
                LabeledContent(e.label(name: name), value: Fmt.time(e.at))
                    .font(.subheadline)
            }
            if events.isEmpty { Text("No events recorded.").foregroundStyle(.secondary) }
        }
    }
}
