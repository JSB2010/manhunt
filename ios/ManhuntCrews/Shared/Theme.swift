import SwiftUI

enum Theme {
    static let hiding = Color(hex: "#1E88E5")
    static let seeking = Color(hex: "#F4511E")
    static let warning = Color.orange
    static let danger = Color.red
    static let ok = Color.green
    static let corner: CGFloat = 16
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: 1)
    }
}

enum Fmt {
    /// m:ss or h:mm:ss
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    static func clock(ms: Double) -> String { clock(ms / 1000) }

    static func distance(_ meters: Double?, units: String) -> String {
        guard let meters else { return "—" }
        if units == "KILOMETERS" {
            return meters < 1000 ? "\(Int(meters)) m" : String(format: "%.2f km", meters / 1000)
        }
        let miles = meters / 1609.344
        return miles < 0.1 ? "\(Int(meters * 3.28084)) ft" : String(format: "%.2f mi", miles)
    }

    static func ago(_ date: Date?, now: Date) -> String {
        guard let date else { return "never" }
        let s = Int(now.timeIntervalSince(date))
        if s < 5 { return "just now" }
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(s / 60)m ago" }
        return "\(s / 3600)h ago"
    }

    static func time(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    static func percent(_ f: Double?) -> String {
        guard let f else { return "—" }
        return "\(Int((f * 100).rounded()))%"
    }
}

struct BigButton: View {
    let title: String
    var systemImage: String?
    var tint: Color = .accentColor
    var role: ButtonRole?
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: 10) {
                if busy { ProgressView().tint(.white) } else if let systemImage { Image(systemName: systemImage) }
                Text(title).font(.title3.weight(.bold))
            }
            .frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .clipShape(RoundedRectangle(cornerRadius: Theme.corner))
        .disabled(busy)
        .accessibilityLabel(title)
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.corner))
    }
}

struct StatusPill: View {
    let text: String
    var color: Color = .secondary
    var systemImage: String?
    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.18), in: Capsule())
        .foregroundStyle(color)
        .accessibilityElement(children: .combine)
    }
}

struct ErrorBanner: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.danger.opacity(0.9), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct StatTile: View {
    let label: String
    let value: String
    var footnote: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.bold)).monospacedDigit()
            if let footnote { Text(footnote).font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// Run an async action with a busy flag and error alert text.
@MainActor
func perform(_ busy: Binding<Bool>, _ errorText: Binding<String?>, _ work: @escaping () async throws -> Void) {
    busy.wrappedValue = true
    Task {
        defer { busy.wrappedValue = false }
        do { try await work() } catch { errorText.wrappedValue = error.localizedDescription }
    }
}

extension View {
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert("Something went wrong", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}

extension String {
    var warningLabel: String {
        let map: [String: String] = [
            "HIDER_PRECISE_LOCATION_OFF": "Hider: Precise Location is off",
            "SEEKER_PRECISE_LOCATION_OFF": "Seeker: Precise Location is off",
            "HIDER_OFFLINE": "Hider phone hasn't checked in recently",
            "SEEKER_OFFLINE": "Seeker phone hasn't checked in recently",
            "HIDER_GPS_STALE": "Hider has no recent GPS fix",
            "SEEKER_GPS_STALE": "Seeker has no recent GPS fix",
            "HIDER_GPS_INACCURATE": "Hider GPS accuracy is poor",
            "SEEKER_GPS_INACCURATE": "Seeker GPS accuracy is poor",
            "HIDER_LOW_POWER_MODE": "Hider is in Low Power Mode",
            "SEEKER_LOW_POWER_MODE": "Seeker is in Low Power Mode",
            "HIDER_LOCATION_PERMISSION_DENIED": "Hider has location permission off",
            "SEEKER_LOCATION_PERMISSION_DENIED": "Seeker has location permission off",
            "HIDER_CONSENT_MISSING": "Hider hasn't accepted the tracking disclosure",
            "SEEKER_CONSENT_MISSING": "Seeker hasn't accepted the tracking disclosure",
        ]
        return map[self] ?? self.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

/// Explicit checkbox row for disclosures/consent: a button that VoiceOver announces
/// as selected/unselected (more legible than a switch for an agreement).
struct CheckRow: View {
    let text: String
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(isOn ? Color.accentColor : .secondary)
                Text(text).font(.callout).foregroundStyle(.primary).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityValue(isOn ? "Checked" : "Not checked")
    }
}
