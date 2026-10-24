import SwiftUI

// The night's sub-screens (ADR 0020): crews by line-up, people, one person's night, export.

// MARK: - Crews

/// One crew of a line-up: its people, how it did hiding and seeking, how far it went.
struct MatchupCrewRow: View {
    let crew: Matchup.Crew
    let matchup: Matchup
    let units: String

    private var stronger: Bool { matchup.comparison.status == "COMPARABLE" && matchup.comparison.strongerHidingTeam == crew.team }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                CrewDot(key: crew.team)
                Text(crew.name).font(.headline)
                if stronger {
                    Image(systemName: "medal.fill").foregroundStyle(Theme.crew(crew.team)).accessibilityLabel("Lasted longest while hiding")
                }
            }
            if !crew.people.isEmpty && !CrewNames.nameListsEveryone(crew.name, people: crew.people, key: crew.team) {
                Text(crew.people.map(\.displayName).formatted(.list(type: .and))).font(.subheadline)
            }
            Group {
                if crew.hideRounds > 0 { Label(hideLine, systemImage: Role.HIDING.symbol) }
                if crew.seekRounds > 0 { Label(seekLine, systemImage: Role.SEEKING.symbol) }
                if let distance = distanceLine { Label(distance, systemImage: "figure.walk") }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .monospacedDigit()
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var hideLine: String {
        let avg = crew.hideAverageSeconds.map { (crew.hideIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—"
        let never = crew.uncaught > 0 ? " · never caught \(times(crew.uncaught))" : ""
        return "Hid \(times(crew.hideRounds)), lasted \(avg)\(crew.hideRounds > 1 ? " on average" : "")\(never)"
    }

    private var seekLine: String { "Sought \(times(crew.seekRounds)), \(crew.catches == 1 ? "1 catch" : "\(crew.catches) catches")" }

    private var distanceLine: String? {
        var parts: [String] = []
        if crew.hiderFootMeters > 0 { parts.append("\(Fmt.distance(crew.hiderFootMeters, units: units)) on foot") }
        if crew.seekerVehicleMeters > 0 { parts.append("\(Fmt.distance(crew.seekerVehicleMeters, units: units)) by car") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func times(_ n: Int) -> String { n == 1 ? "once" : n == 2 ? "twice" : "\(n) times" }
}

/// Crews changed during the night: each line-up (the same people on each crew, the same rules) on its own.
struct MatchupsView: View {
    let matchups: [Matchup]
    let units: String

    var body: some View {
        List {
            Section {
                ExplainerRow(title: "Why line-ups?", detail: "Crews changed during the night. A comparison is only fair over rounds played by the same people on each crew under the same rules, so each line-up is compared on its own.")
            }
            ForEach(matchups) { m in
                Section {
                    ForEach(m.crews) { MatchupCrewRow(crew: $0, matchup: m, units: units) }
                } header: {
                    Text(m.title)
                } footer: {
                    if m.crews.count > 1 { Text(StatsText.comparisonNote(m.comparison)) }
                }
            }
        }
        .navigationTitle("Crews")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Totals per crew colour, for servers from before line-ups.
struct LegacyTeamSection: View {
    let key: TeamKey
    let score: TeamScore
    let roster: [PersonRef]
    let units: String

    var body: some View {
        Section {
            LabeledContent("Rounds hidden", value: "\(score.hideRoundCount)")
            LabeledContent("Average survival", value: score.hideSurvivalAverageSeconds.map { (score.hideSurvivalAverageIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("Caught / not caught", value: "\(score.caughtCount) / \(score.uncaughtCount)")
            LabeledContent("Average time to find", value: score.seekCaptureAverageSeconds.map { Fmt.clock(Double($0)) } ?? "—")
            LabeledContent("On foot (hiding)", value: Fmt.distance(score.hiderFootMetersTotal, units: units))
            LabeledContent("By car (seeking)", value: Fmt.distance(score.seekerVehicleMetersChase, units: units))
        } header: {
            HStack(spacing: 8) {
                CrewDot(key: key)
                Text(score.name)
            }
        } footer: {
            if !roster.isEmpty { Text(roster.map(\.displayName).formatted(.list(type: .and))) }
        }
        .monospacedDigit()
    }
}

// MARK: - People

/// Everyone who played, sortable. Every figure is their crew's, from the rounds they played (spec §6.3).
struct NightPeopleSection: View {
    enum Sort: String, CaseIterable, Identifiable {
        case rounds = "Rounds", hiding = "Hiding", catches = "Catches", onFoot = "On Foot"
        var id: String { rawValue }
    }

    let sessionId: String
    let people: [PersonNightStats]
    let rounds: [RoundResult]
    let units: String
    @State private var sort: Sort = .rounds
    @Environment(\.dynamicTypeSize) private var typeSize

    /// "On Foot" needs a server that reports distances per person (ADR 0020).
    private var sorts: [Sort] { people.contains { $0.footMeters != nil } ? Sort.allCases : [.rounds, .hiding, .catches] }

    private var sorted: [PersonNightStats] {
        let byName = { (a: PersonNightStats, b: PersonNightStats) in a.displayName.localizedStandardCompare(b.displayName) == .orderedAscending }
        func desc<T: Comparable>(_ v: @escaping (PersonNightStats) -> T?) -> (PersonNightStats, PersonNightStats) -> Bool {
            { a, b in
                switch (v(a), v(b)) {
                case let (x?, y?): x != y ? x > y : byName(a, b)
                case (_?, nil): true
                case (nil, _?): false
                default: byName(a, b)
                }
            }
        }
        switch sort {
        case .rounds: return people.sorted(by: desc { $0.roundsPlayed })
        case .hiding: return people.sorted(by: desc { $0.hideAverageSeconds })
        case .catches: return people.sorted(by: desc { $0.catches })
        case .onFoot: return people.sorted(by: desc { $0.footMeters })
        }
    }

    var body: some View {
        Section {
            sortPicker.accessibilityIdentifier("night.people.sort")
            ForEach(sorted) { p in
                NavigationLink { PersonNightView(sessionId: sessionId, person: p, rounds: rounds, units: units) } label: {
                    LabeledContent {
                        Text(value(p)).monospacedDigit()
                    } label: {
                        Text(p.displayName)
                        Text("Hid \(p.roundsHid) · sought \(p.roundsSought) · \(p.catches == 1 ? "1 catch" : "\(p.catches) catches")")
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("People")
        } footer: {
            Text("Everyone gets their crew’s results from the rounds they played: how long it lasted while they hid with it, its catches and its distance. Crew results, not individual performance.")
        }
    }

    /// Segmented, or a menu at accessibility text sizes where four segments won't fit.
    @ViewBuilder private var sortPicker: some View {
        let picker = Picker("Sort by", selection: $sort) {
            ForEach(sorts) { Text($0.rawValue).tag($0) }
        }
        if typeSize.isAccessibilitySize { picker.pickerStyle(.menu) } else { picker.pickerStyle(.segmented) }
    }

    private func value(_ p: PersonNightStats) -> String {
        switch sort {
        case .rounds: return p.roundsPlayed == 1 ? "1 round" : "\(p.roundsPlayed) rounds"
        case .hiding: return p.hideAverageSeconds.map { (p.hideIncludesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—"
        case .catches: return "\(p.catches)"
        case .onFoot: return p.footMeters.map { Fmt.distance($0, units: units) } ?? "—"
        }
    }
}

/// One person's night: their crews' results while they played, their longest and shortest rounds,
/// and every round. Crew-level throughout (spec §6.3), never the person's own performance.
struct PersonNightView: View {
    let sessionId: String
    let person: PersonNightStats
    let rounds: [RoundResult]
    let units: String

    private func crewName(_ pr: PersonNightStats.Round) -> String {
        rounds.first { $0.roundIndex == pr.roundIndex }?.name(pr.team) ?? pr.team.colourName
    }

    var body: some View {
        List {
            Section {
                StatGrid {
                    StatTile(label: "Hiding", value: rounds(person.roundsHid), detail: hideDetail, symbol: Role.HIDING.symbol)
                    StatTile(label: "Seeking", value: rounds(person.roundsSought), detail: person.catches == 1 ? "1 catch by their crew" : "\(person.catches) catches by their crews", symbol: Role.SEEKING.symbol)
                    if let m = person.footMeters {
                        StatTile(label: "On foot", value: Fmt.distance(m, units: units), detail: "With their crews, hiding", symbol: "figure.walk")
                    }
                    if let m = person.driveMeters {
                        StatTile(label: "By car", value: Fmt.distance(m, units: units), detail: "With their crews, seeking", symbol: "car.fill")
                    }
                }
                .bareListRow()
            } footer: {
                Text("Crew results from the rounds \(person.displayName) played, not individual performance.")
            }
            let ranges = StatsText.ranges(person.rounds ?? [], units: units)
            if !ranges.isEmpty {
                Section("Longest and Shortest") {
                    ForEach(ranges) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(r.title).font(.subheadline.weight(.semibold))
                            extreme(r.highLabel, r.high, "arrow.up")
                            extreme(r.lowLabel, r.low, "arrow.down")
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if let played = person.rounds, !played.isEmpty {
                Section("Rounds") {
                    ForEach(played) { pr in
                        let round = rounds.first { $0.roundIndex == pr.roundIndex }
                        NavigationLink { if let round { RoundRecapView(sessionId: sessionId, roundId: round.roundId) } } label: {
                            LabeledContent {
                                Text(pr.meters.map { Fmt.distance($0, units: units) + (pr.estimated ? " (est.)" : "") } ?? "—").monospacedDigit()
                            } label: {
                                Label { Text("Round \(pr.roundIndex)") } icon: {
                                    Image(systemName: pr.role.symbol).foregroundStyle(Theme.crew(pr.team))
                                }
                                Text(line(pr))
                            }
                        }
                        .disabled(round == nil)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .navigationTitle(person.displayName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func rounds(_ n: Int) -> String { n == 1 ? "1 round" : "\(n) rounds" }

    private var hideDetail: String {
        guard let avg = person.hideAverageSeconds else { return "Didn’t hide" }
        return "Crew lasted \((person.hideIncludesCensored ? "≥ " : "") + Fmt.clock(Double(avg)))\(person.roundsHid > 1 ? " on average" : "")"
    }

    private func extreme(_ label: String, _ e: (value: String, round: Int), _ symbol: String) -> some View {
        HStack {
            Label { Text("\(label): \(e.value)") } icon: { Image(systemName: symbol).foregroundStyle(.secondary) }
            Spacer()
            Text("Round \(e.round)").foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .monospacedDigit()
    }

    /// "Hid with Sasha & Marco · caught after 12:34", "Sought with Theo & Priya · made the catch at 6:02".
    private func line(_ pr: PersonNightStats.Round) -> String {
        let t = Fmt.clock(Double(pr.seconds))
        let with = crewName(pr)
        if pr.role == .HIDING {
            return "Hid with \(with) · \(pr.outcome == "CAUGHT" ? "caught after \(t)" : "never caught (≥ \(t))")"
        }
        let result = pr.credited ? "made the catch at \(t)" : pr.outcome == "CAUGHT" ? "another crew made the catch" : "no catch"
        return "Sought with \(with) · \(result)"
    }
}

// MARK: - Export

/// Advanced: the night's scores as files. No GPS coordinates are exported.
struct NightDataView: View {
    @Environment(AppModel.self) private var model
    let sessionId: String
    @State private var exportURL: URL?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Button { export("csv") } label: { Label("Export CSV", systemImage: "tablecells") }
                Button { export("json") } label: { Label("Export JSON", systemImage: "curlybraces") }
                if let exportURL {
                    ShareLink(item: exportURL) { Label("Share \(exportURL.pathExtension.uppercased()) File", systemImage: "square.and.arrow.up") }
                }
            } footer: {
                Text("Every round’s scores and crews, as a spreadsheet (CSV) or data (JSON). No GPS coordinates are exported.")
            }
        }
        .disabled(busy)
        .navigationTitle("Export Data")
        .navigationBarTitleDisplayMode(.inline)
        .errorAlert($error)
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
