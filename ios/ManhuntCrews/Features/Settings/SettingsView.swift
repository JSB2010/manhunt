import SwiftUI
import CoreLocation

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var units = "MILES"
    @State private var confirmDelete = false
    @State private var showPrivacy = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Account") {
                TextField("Display name", text: $name)
                LabeledContent("Handle", value: "@\(model.me?.profile.handle ?? "")")
                if let email = model.me?.profile.email { LabeledContent("Email", value: email) }
                Picker("Units", selection: $units) {
                    Text("Miles").tag("MILES")
                    Text("Kilometers").tag("KILOMETERS")
                }
                Button("Save") {
                    perform($busy, $error) { model.me = try await model.api.patchMe(displayName: name, units: units); model.show("Saved") }
                }
            }
            Section("Location diagnostics") {
                let loc = model.location
                LabeledContent("Permission", value: loc.permissionString.replacingOccurrences(of: "_", with: " ").capitalized)
                LabeledContent("Precise Location", value: loc.preciseLocation ? "On" : "Off")
                LabeledContent("Tracking", value: loc.mode == .tracking ? "Active (round)" : loc.mode == .preflight ? "Ready check" : "Off")
                LabeledContent("Last fix", value: loc.lastFix.map { "\(Fmt.ago($0.timestamp, now: Date())) · ±\(Int($0.horizontalAccuracy)) m" } ?? "—")
                LabeledContent("Unsent samples", value: "\(loc.queuedSamples)")
                LabeledContent("Last upload", value: loc.lastUploadAt.map { Fmt.ago($0, now: Date()) } ?? "—")
                if let e = loc.lastUploadError { Text(e).font(.caption).foregroundStyle(.orange) }
                LabeledContent("Device clock vs server", value: String(format: "%+.1f s", ServerClock.shared.deviceOffsetSeconds))
                Button("Open iOS Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                Text("Tracking runs only during rounds. iOS can pause background location; force-quitting the app stops tracking until you reopen it.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Notifications") {
                LabeledContent("Status", value: model.notifications.authorized ? "Allowed" : "Off")
                if !model.notifications.authorized { Button("Enable notifications") { Task { await model.notifications.requestAuthorization() } } }
                LabeledContent("Remote push", value: model.env.pushEnabled ? "Enabled" : "Needs paid Apple Developer Program")
            }
            Section("Privacy & data") {
                Button("Privacy summary") { showPrivacy = true }
                Text("Raw GPS: deleted after 30 days. Simplified routes & stats: kept until you delete them. Photos: 7 days if not confirmed, 30 days if confirmed (unless both operators keep them). Delete your data per night from History.").font(.caption)
                Button("Delete my account", role: .destructive) { confirmDelete = true }
            }
            Section("About") {
                LabeledContent("Version", value: model.env.appVersion)
                LabeledContent("Server", value: model.env.apiBaseURL.host ?? "")
                if model.env.useEmulators { Text("Development build using local emulators.").font(.caption).foregroundStyle(.orange) }
                Button("Sign out", role: .destructive) { Task { await model.signOut() } }
            }
        }
        .navigationTitle("Settings")
        .onAppear {
            name = model.me?.profile.displayName ?? ""
            units = model.me?.profile.preferences.units ?? "MILES"
        }
        .sheet(isPresented: $showPrivacy) { PrivacySummaryView() }
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete account and my location data", role: .destructive) {
                perform($busy, $error) {
                    _ = try await model.api.deleteAccount()
                    await model.signOut()
                }
            }
        } message: { Text("Removes your profile, friends, your operator tracks and photos. Other operators keep crew scores with your name anonymized.") }
        .errorAlert($error)
    }
}
