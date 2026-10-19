import SwiftUI

/// Design tokens (docs/design-system.md). Each colour means one thing:
/// - accent: "go" actions and OK status,
/// - crew colours: crew identity — never the role; hiding/seeking is always a symbol and a word,
/// - warning / danger: status, always paired with a symbol.
/// All are asset-catalog colours with dark and increased-contrast variants that keep
/// text at 4.5:1 or better on system backgrounds.
enum Theme {
    static func crew(_ key: TeamKey) -> Color { key == .A ? Color(.crewA) : Color(.crewB) }
    static let ok = Color.accentColor
    static let warning = Color(.warning)
    static let danger = Color(.danger)
    /// Corner radius for photos and maps shown inside scrolling content.
    static let mediaCorner: CGFloat = 20
}

extension Role {
    /// Hiding = unseen, seeking = looking. The symbol and label carry the role; colour carries the crew.
    var symbol: String { self == .HIDING ? "eye.slash.fill" : "binoculars.fill" }
}

enum Fmt {
    /// m:ss or h:mm:ss
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    static func clock(ms: Double) -> String { clock(ms / 1000) }

    /// Spoken form of a clock value for VoiceOver ("12 minutes 5 seconds").
    static func spokenDuration(_ seconds: Double) -> String {
        let f = DateComponentsFormatter()
        f.unitsStyle = .full
        f.allowedUnits = seconds >= 3600 ? [.hour, .minute, .second] : [.minute, .second]
        return f.string(from: max(0, seconds.rounded(.down))) ?? clock(seconds)
    }

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

    /// "2026-10-18" (a night’s scheduled date) → localized "Oct 18, 2026".
    static func day(_ iso: String) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        guard let date = f.date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    static func percent(_ f: Double?) -> String {
        guard let f else { return "—" }
        return "\(Int((f * 100).rounded()))%"
    }

    /// "Caught after 12:34" / "Not caught (≥ 45:00)" / "Aborted" for a round outcome.
    static func outcome(_ outcome: String, seconds: Int) -> String {
        switch outcome {
        case "CAUGHT": clock(Double(seconds))
        case "TIMED_OUT": "≥ \(clock(Double(seconds)))"
        default: "Aborted"
        }
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
        alert("Couldn’t Complete That", isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
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
            "HIDER_OFFLINE": "Hider phone hasn’t checked in recently",
            "SEEKER_OFFLINE": "Seeker phone hasn’t checked in recently",
            "HIDER_GPS_STALE": "Hider has no recent GPS fix",
            "SEEKER_GPS_STALE": "Seeker has no recent GPS fix",
            "HIDER_GPS_INACCURATE": "Hider GPS accuracy is poor",
            "SEEKER_GPS_INACCURATE": "Seeker GPS accuracy is poor",
            "HIDER_LOW_POWER_MODE": "Hider is in Low Power Mode",
            "SEEKER_LOW_POWER_MODE": "Seeker is in Low Power Mode",
            "HIDER_LOCATION_PERMISSION_DENIED": "Hider has location permission off",
            "SEEKER_LOCATION_PERMISSION_DENIED": "Seeker has location permission off",
            "HIDER_CONSENT_MISSING": "Hider hasn’t accepted the tracking disclosure",
            "SEEKER_CONSENT_MISSING": "Seeker hasn’t accepted the tracking disclosure",
        ]
        return map[self] ?? self.replacingOccurrences(of: "_", with: " ").capitalized
    }
}
