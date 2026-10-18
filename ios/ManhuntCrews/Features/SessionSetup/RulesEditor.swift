import SwiftUI

/// Host-editable rules with the spec §4 ranges enforced in the UI (and again on the server).
struct RulesEditor: View {
    @Binding var rules: Rules
    var lockFirstHider = false
    var teamNames: (A: String, B: String) = ("Crew A", "Crew B")
    @State private var showAdvanced = false

    var body: some View {
        Section {
            Stepper(value: Binding(get: { rules.headStartSeconds / 60 }, set: { rules.headStartSeconds = $0 * 60 }), in: 0...60) {
                LabeledContent("Head start", value: "\(rules.headStartSeconds / 60) min")
            }
            Stepper(value: Binding(get: { rules.pingIntervalSeconds / 60 }, set: { rules.pingIntervalSeconds = $0 * 60 }), in: 1...60) {
                LabeledContent("Ping every", value: "\(rules.pingIntervalSeconds / 60) min")
            }
            Text("The first ping releases when the head start ends, then on this interval.").font(.caption).foregroundStyle(.secondary)
            Picker("Visible past pins", selection: Binding(get: { rules.visiblePingHistoryCount ?? 0 }, set: { rules.visiblePingHistoryCount = $0 == 0 ? nil : $0 })) {
                ForEach([1, 2, 3, 5, 10], id: \.self) { Text("\($0)").tag($0) }
                Text("All").tag(0)
            }
            Stepper(value: $rules.totalRounds, in: 1...20) { LabeledContent("Rounds", value: "\(rules.totalRounds)") }
            if !lockFirstHider {
                Picker("Hides first", selection: $rules.initialHidingTeam) {
                    Text(teamNames.A).tag(TeamKey.A)
                    Text(teamNames.B).tag(TeamKey.B)
                }
            }
            Toggle("Switch roles each round", isOn: $rules.alternateRoles)
        } header: {
            Text("Rules")
        }
        Section {
            Toggle("Chase time limit", isOn: Binding(get: { rules.maxChaseSeconds != nil }, set: { rules.maxChaseSeconds = $0 ? 60 * 60 : nil }))
            if let cap = rules.maxChaseSeconds {
                Stepper(value: Binding(get: { cap / 60 }, set: { rules.maxChaseSeconds = $0 * 60 }), in: 5...360, step: 5) {
                    LabeledContent("Limit", value: "\(cap / 60) min")
                }
                Text("Reaching the limit records the round as not caught (survived at least the limit).").font(.caption).foregroundStyle(.secondary)
            }
            Stepper(value: $rules.confirmationTimeoutSeconds, in: 30...600, step: 30) {
                LabeledContent("Catch confirmation window", value: "\(rules.confirmationTimeoutSeconds) s")
            }
            Toggle("Manual pauses (both must agree)", isOn: $rules.manualPausesEnabled)
            DisclosureGroup("GPS thresholds", isExpanded: $showAdvanced) {
                Stepper(value: $rules.maxPingGpsAgeSeconds, in: 10...300, step: 10) {
                    LabeledContent("Max fix age for a ping", value: "\(rules.maxPingGpsAgeSeconds) s")
                }
                Stepper(value: $rules.maxPingAccuracyMeters, in: 5...200, step: 5) {
                    LabeledContent("Max accuracy for a ping", value: "\(rules.maxPingAccuracyMeters) m")
                }
                Text("If no fix meets these, the ping is marked unavailable instead of revealing a stale or vague point.").font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Timing & fairness")
        }
    }
}
