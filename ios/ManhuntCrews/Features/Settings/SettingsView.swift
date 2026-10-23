import SwiftUI
import CoreLocation

/// Account & Settings, presented from the Play tab’s profile button.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var units = "MILES"
    @State private var confirmDelete = false
    @State private var confirmSignOut = false
    @State private var showPrivacy = false
    @State private var busy = false
    @State private var error: String?

    private var profileChanged: Bool {
        name != (model.me?.profile.displayName ?? "") || units != (model.me?.profile.preferences.units ?? "MILES")
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Display name") {
                    TextField("Display name", text: $name)
                        .multilineTextAlignment(.trailing)
                        .textContentType(.nickname)
                }
                LabeledContent("Handle", value: "@\(model.me?.profile.handle ?? "")")
                if let email = model.me?.profile.email { LabeledContent("Email", value: email) }
                Picker("Distance units", selection: $units) {
                    Text("Miles").tag("MILES")
                    Text("Kilometers").tag("KILOMETERS")
                }
                if profileChanged {
                    Button("Save Changes") {
                        perform($busy, $error) { model.me = try await model.api.patchMe(displayName: name, units: units); model.show("Saved") }
                    }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("Account")
            }

            Section {
                let loc = model.location
                StatusRow(title: "Permission", value: loc.permissionString.replacingOccurrences(of: "_", with: " ").capitalized, state: loc.isAuthorized ? .ok : .problem)
                // Accuracy means nothing until location is allowed (it reads "full" before the first prompt).
                StatusRow(title: "Precise Location", value: !loc.isAuthorized ? "—" : loc.preciseLocation ? "On" : "Off", state: !loc.isAuthorized ? .neutral : loc.preciseLocation ? .ok : .warning)
                LabeledContent("Tracking", value: loc.mode == .tracking ? "Active (round)" : loc.mode == .preflight ? "Ready check" : "Off")
                LabeledContent("Last fix", value: loc.lastFix.map { "\(Fmt.ago($0.timestamp, now: Date())) · ±\(Int($0.horizontalAccuracy)) m" } ?? "—")
                LabeledContent("Unsent samples", value: "\(loc.queuedSamples)")
                LabeledContent("Last upload", value: loc.lastUploadAt.map { Fmt.ago($0, now: Date()) } ?? "—")
                if let e = loc.lastUploadError {
                    Label(e, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                LabeledContent("Device clock vs. server", value: abs(ServerClock.shared.deviceOffsetSeconds) < 0.05 ? "In sync" : String(format: "%+.1f s", ServerClock.shared.deviceOffsetSeconds))
                    .monospacedDigit()
                Button("Open iOS Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            } header: {
                Text("Location Diagnostics")
            } footer: {
                Text("Force-quitting the app stops tracking until you reopen it.")
            }

            Section("Notifications") {
                StatusRow(title: "Status", value: model.notifications.authorized ? "Allowed" : "Off", state: model.notifications.authorized ? .ok : .neutral)
                if !model.notifications.authorized {
                    Button("Turn On Notifications") { Task { await model.notifications.requestAuthorization() } }
                }
            }

            Section {
                let live = model.liveActivities
                Toggle("Show Rounds on Lock Screen", isOn: Binding(get: { live.enabled }, set: { live.enabled = $0 }))
                    .disabled(!live.systemAllowed)
                if !live.systemAllowed {
                    StatusRow(title: "iOS Setting", value: "Off", state: .neutral)
                    Button("Open iOS Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            } header: {
                Text("Live Activities")
            } footer: {
                Text("The round’s phase, clock and next ping on the Lock Screen, in the Dynamic Island and on Apple Watch. It never shows a location.")
            }

            Section("Privacy & Data") {
                Button("Privacy Summary") { showPrivacy = true }
                Button("Delete My Account", role: .destructive) { confirmDelete = true }
            }

            Section {
                LabeledContent("Version", value: model.env.appVersion)
                LabeledContent("Server", value: model.env.apiBaseURL.host ?? "")
                if let url = model.env.privacyPolicyURL {
                    Link(destination: url) { Label("Privacy Policy", systemImage: "hand.raised") }
                }
                if let url = model.env.supportURL {
                    Link(destination: url) { Label("Support", systemImage: "questionmark.circle") }
                }
                if model.env.useEmulators {
                    Label("Development build using local emulators.", systemImage: "hammer.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("About")
            }

            Section {
                Button("Sign Out", role: .destructive) { confirmSignOut = true }
            }
        }
        .navigationTitle("Account & Settings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            name = model.me?.profile.displayName ?? ""
            units = model.me?.profile.preferences.units ?? "MILES"
        }
        .sheet(isPresented: $showPrivacy) { PrivacySummaryView() }
        .confirmationDialog("Sign out of Manhunt Crews?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
        }
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Account and My Location Data", role: .destructive) {
                perform($busy, $error) {
                    _ = try await model.api.deleteAccount()
                    await model.signOut()
                }
            }
        } message: { Text("Removes your profile, friends, tracks and photos; crew scores stay with your name anonymized.") }
        .errorAlert($error)
    }
}
