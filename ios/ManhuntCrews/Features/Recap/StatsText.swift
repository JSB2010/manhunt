import Foundation

/// The words for highlights, ranks and verdicts, in one place so the round recap, the night,
/// the share cards and VoiceOver all say the same thing (ADR 0020). Pure functions: unit-tested.
enum StatsText {
    // MARK: Highlights

    static func title(_ k: NightHighlight.Kind) -> String {
        switch k {
        case .LONGEST_HIDE: "Longest hide"
        case .FASTEST_CATCH: "Fastest catch"
        case .MOST_ON_FOOT: "Most ground on foot"
        case .LEAST_ON_FOOT: "Least ground on foot"
        case .MOST_DRIVING: "Most driving"
        case .LEAST_DRIVING: "Least driving"
        }
    }

    static func symbol(_ k: NightHighlight.Kind) -> String {
        switch k {
        case .LONGEST_HIDE: "hourglass.bottomhalf.filled"
        case .FASTEST_CATCH: "bolt.fill"
        case .MOST_ON_FOOT: "figure.run"
        case .LEAST_ON_FOOT: "figure.stand"
        case .MOST_DRIVING: "car.fill"
        case .LEAST_DRIVING: "car"
        }
    }

    /// "≥ 45:00", "6:02", "1.24 mi", "0.10 mi (estimated)"
    static func value(_ h: NightHighlight, units: String) -> String {
        if h.isDistance { return Fmt.distance(h.value, units: units) + (h.estimated ? " (est.)" : "") }
        return (h.censored ? "≥ " : "") + Fmt.clock(h.value)
    }

    /// What a highlight says about its crews, in a sentence (VoiceOver, share cards).
    static func sentence(_ h: NightHighlight, units: String) -> String {
        let who = h.names.formatted(.list(type: .and))
        let v = value(h, units: units)
        switch h.kind {
        case .LONGEST_HIDE: return h.censored ? "\(who) were never caught in round \(h.roundIndex): at least \(Fmt.clock(h.value))" : "\(who) hid for \(v) in round \(h.roundIndex)"
        case .FASTEST_CATCH: return "\(who) made the catch in \(v) in round \(h.roundIndex)"
        case .MOST_ON_FOOT, .LEAST_ON_FOOT: return "\(who) covered \(v) on foot in round \(h.roundIndex)"
        case .MOST_DRIVING, .LEAST_DRIVING: return "\(who) drove \(v) in round \(h.roundIndex)"
        }
    }

    /// A badge on the round that set it: "Longest hide so far" between rounds, "Longest hide of the night" after.
    static func badge(_ k: NightHighlight.Kind, live: Bool) -> String { "\(title(k)) \(live ? "so far" : "of the night")" }

    // MARK: Where a round ranks

    /// Where a round's chase time ranks among the night's played rounds: "First round of the night",
    /// "Longest hide of 4 rounds", "2nd-longest of 4 rounds so far", "Shortest of 4 rounds". Nil when aborted.
    static func hideRank(of roundIndex: Int, in rounds: [RoundResult], live: Bool) -> String? {
        let played = rounds.filter { $0.outcome != "ABORTED" }
        guard let me = played.first(where: { $0.roundIndex == roundIndex }) else { return nil }
        guard played.count >= 2 else { return "First round of the night" }
        let suffix = live ? " so far" : ""
        let rank = played.filter { $0.observedChaseSeconds > me.observedChaseSeconds }.count + 1
        let tiedLast = played.allSatisfy { $0.observedChaseSeconds >= me.observedChaseSeconds }
        if rank == 1 { return "Longest hide of \(played.count) rounds\(suffix)" }
        if tiedLast { return "Shortest hide of \(played.count) rounds\(suffix)" }
        return "\(ordinal(rank))-longest of \(played.count) rounds\(suffix)"
    }

    static func ordinal(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .ordinal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    // MARK: The night's verdict

    struct Verdict: Equatable {
        var title: String
        var detail: String
        var symbol: String
        /// the stronger hiding crew, when there is one
        var crew: TeamKey?
    }

    /// The night comparison in plain words. A stronger crew is named only when the comparison is
    /// COMPARABLE (spec §6.2); otherwise it says why not, without alarm: the highlights still stand.
    static func verdict(_ c: NightComparison, matchups: Int, name: (TeamKey) -> String) -> Verdict {
        if matchups > 1 {
            return Verdict(title: "Crews changed during the night", detail: "Each line-up is compared only with itself: \(matchups) line-ups under Crews.", symbol: "arrow.triangle.swap")
        }
        switch c.status {
        case "COMPARABLE":
            if let k = c.strongerHidingTeam {
                let by = c.marginSeconds.map { " by \(Fmt.clock(Double($0)))" } ?? ""
                return Verdict(title: "\(name(k)) lasted longest hiding", detail: "On average\(by), with every crew hiding equally often under the same rules.", symbol: "medal.fill", crew: k)
            }
            return Verdict(title: "Dead even", detail: "Every crew lasted just as long on average.", symbol: "equal.circle.fill")
        case "PROVISIONAL":
            let why = c.reasons.compactMap(reason).formatted(.list(type: .and))
            return Verdict(title: "No overall result", detail: "Crews are ranked only when they hid equally often under the same rules\(why.isEmpty ? "" : ". Tonight \(why)").", symbol: "scalemass")
        default:
            return Verdict(title: "Not every crew has hidden", detail: "Crews are compared once each one has hidden.", symbol: "hourglass")
        }
    }

    /// Under a line-up's crews: the server's sentence when crews are compared, else why not, in plain words.
    static func comparisonNote(_ c: NightComparison) -> String {
        guard c.status == "PROVISIONAL" else { return c.explanation }
        let why = c.reasons.compactMap(reason).formatted(.list(type: .and))
        return why.isEmpty ? "Not ranked." : "Not ranked: \(why)."
    }

    static func reason(_ code: String) -> String? {
        switch code {
        case "UNEQUAL_HIDE_ROUNDS": "crews hid an unequal number of times"
        case "RULES_DIFFER": "the rules changed"
        case "ROSTERS_CHANGED": "crews changed"
        case "CENSORED_ROUNDS": "a round ran to the time limit"
        case "ABORTED_ROUNDS": "a round was aborted"
        default: nil
        }
    }

    // MARK: A person's night

    /// The most and least of one measure over a person's rounds (crew-level).
    struct Range: Equatable, Identifiable {
        var title: String
        /// "Longest" / "Most"
        var highLabel: String
        var lowLabel: String
        var high: (value: String, round: Int)
        var low: (value: String, round: Int)
        var id: String { title }
        static func == (a: Range, b: Range) -> Bool { a.title == b.title && a.high == b.high && a.low == b.low }
    }

    /// Longest vs shortest hide, most vs least on foot and by car, over the rounds a person played.
    /// Each needs two rounds with different values.
    static func ranges(_ rounds: [PersonNightStats.Round], units: String) -> [Range] {
        func range(_ title: String, _ words: (String, String), _ xs: [PersonNightStats.Round], _ v: (PersonNightStats.Round) -> Double?, _ text: (PersonNightStats.Round, Double) -> String) -> Range? {
            let vals = xs.compactMap { r in v(r).map { (r, $0) } }
            guard vals.count >= 2,
                  let hi = vals.max(by: { $0.1 < $1.1 || ($0.1 == $1.1 && $0.0.roundIndex > $1.0.roundIndex) }),
                  let lo = vals.min(by: { $0.1 < $1.1 || ($0.1 == $1.1 && $0.0.roundIndex < $1.0.roundIndex) }),
                  lo.1 < hi.1 else { return nil }
            return Range(title: title, highLabel: words.0, lowLabel: words.1, high: (text(hi.0, hi.1), hi.0.roundIndex), low: (text(lo.0, lo.1), lo.0.roundIndex))
        }
        let hid = rounds.filter { $0.role == .HIDING }
        let sought = rounds.filter { $0.role == .SEEKING }
        let dist = { (r: PersonNightStats.Round, m: Double) in Fmt.distance(m, units: units) + (r.estimated ? " (est.)" : "") }
        return [
            range("Hiding time", ("Longest", "Shortest"), hid, { Double($0.seconds) }, { r, s in (r.censored ? "≥ " : "") + Fmt.clock(s) }),
            range("On foot while hiding", ("Most", "Least"), hid, \.meters, dist),
            range("By car while seeking", ("Most", "Least"), sought, \.meters, dist),
        ].compactMap { $0 }
    }
}

/// The words for one round's result, shared by the recap and its share card.
enum RecapText {
    /// "Caught after 12:34", "Never caught", "Round aborted"
    static func headline(_ r: RoundResult) -> String {
        switch r.outcome {
        case "CAUGHT": "Caught after \(Fmt.clock(Double(r.observedChaseSeconds)))"
        case "TIMED_OUT": "Never caught"
        default: "Round aborted"
        }
    }

    /// The line under the headline: the head start, the time limit reached, or why it was aborted.
    static func subline(_ r: RoundResult) -> String? {
        switch r.outcome {
        case "CAUGHT": "Chase time, after a \(Fmt.clock(Double(r.headStartSeconds))) head start"
        case "TIMED_OUT": "Hid for the full \(Fmt.clock(Double(r.observedChaseSeconds))) time limit"
        default: r.abortedReason
        }
    }

    /// "Theo & Priya found them", "Theo made the catch" (Race), "Theo & Priya sought".
    static func seekersLine(_ r: RoundResult) -> String {
        guard r.outcome == "CAUGHT", !r.catchCreditTeams.isEmpty else { return "\(r.seekersName) sought" }
        if r.seekMode == .RACE && r.seekingTeams.count > 1 { return "\(r.catchCreditTeams.map(r.name).formatted(.list(type: .and))) made the catch" }
        return "\(r.seekersName) found them"
    }

    /// A crew's distance as the recap shows it, or nil when its GPS isn't usable.
    static func distance(_ c: CrewRouteStats?, chaseOnly: Bool = false) -> Double? {
        guard let c, c.routeQuality != "INSUFFICIENT" else { return nil }
        return chaseOnly || c.role == .SEEKING ? c.distanceChaseMeters : c.distanceTotalMeters
    }

    struct Number: Equatable { var label: String; var value: String }

    /// Two or three numbers for a share card: on foot, by car (one seeking crew), pings.
    static func cardNumbers(_ r: RoundResult, units: String) -> [Number] {
        var out: [Number] = []
        if let m = distance(r.crew(r.hidingTeam)) { out.append(Number(label: "On foot", value: Fmt.distance(m, units: units))) }
        if r.seekingTeams.count == 1, let k = r.seekingTeams.first, let m = distance(r.crew(k)) { out.append(Number(label: "By car", value: Fmt.distance(m, units: units))) }
        if r.pingSlots > 0 { out.append(Number(label: "Pings", value: "\(r.pingsReleased) of \(r.pingSlots)")) }
        return out
    }
}
