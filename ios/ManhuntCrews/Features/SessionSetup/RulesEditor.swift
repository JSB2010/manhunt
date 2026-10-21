import SwiftUI

/// Rules with the spec §4 ranges enforced in the UI (and again on the server).
struct RulesEditor: View {
    @Binding var rules: Rules
    @State private var showAdvanced = false

    var body: some View {
        Section {
            Stepper(value: Binding(get: { rules.headStartSeconds / 60 }, set: { rules.headStartSeconds = $0 * 60 }), in: 0...60) {
                LabeledContent("Head start", value: "\(rules.headStartSeconds / 60) min")
            }
            Stepper(value: Binding(get: { rules.pingIntervalSeconds / 60 }, set: { rules.pingIntervalSeconds = $0 * 60 }), in: 1...60) {
                LabeledContent("Ping every", value: "\(rules.pingIntervalSeconds / 60) min")
            }
            Picker("Visible past pins", selection: Binding(get: { rules.visiblePingHistoryCount ?? 0 }, set: { rules.visiblePingHistoryCount = $0 == 0 ? nil : $0 })) {
                ForEach([1, 2, 3, 5, 10], id: \.self) { Text("\($0)").tag($0) }
                Text("All").tag(0)
            }
        } header: {
            Text("Rules")
        }
        Section {
            Toggle("Chase time limit", isOn: Binding(get: { rules.maxChaseSeconds != nil }, set: { rules.maxChaseSeconds = $0 ? 60 * 60 : nil }))
            if let cap = rules.maxChaseSeconds {
                Stepper(value: Binding(get: { cap / 60 }, set: { rules.maxChaseSeconds = $0 * 60 }), in: 5...360, step: 5) {
                    LabeledContent("Limit", value: "\(cap / 60) min")
                }
            }
            Stepper(value: $rules.confirmationTimeoutSeconds, in: 30...600, step: 30) {
                LabeledContent("Catch confirmation window", value: "\(rules.confirmationTimeoutSeconds) s")
            }
            Toggle("Manual pauses (both sides agree)", isOn: $rules.manualPausesEnabled)
            DisclosureGroup("GPS Thresholds", isExpanded: $showAdvanced) {
                Stepper(value: $rules.maxPingGpsAgeSeconds, in: 10...300, step: 10) {
                    LabeledContent("Max fix age for a ping", value: "\(rules.maxPingGpsAgeSeconds) s")
                }
                Stepper(value: $rules.maxPingAccuracyMeters, in: 5...200, step: 5) {
                    LabeledContent("Max accuracy for a ping", value: "\(rules.maxPingAccuracyMeters) m")
                }
                Text("A ping waits until a fix meets these.").font(.footnote).foregroundStyle(.secondary)
            }
        } header: {
            Text("Timing & Fairness")
        }
    }
}
