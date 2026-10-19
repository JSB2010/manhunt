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
                StatusRow(title: "Precise Location", value: loc.preciseLocation ? "On" : "Off", state: loc.preciseLocation ? .ok : .warning)
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
                Text("Tracking runs only during rounds. iOS can pause background location; force-quitting the app stops tracking until you reopen it.")
            }

            Section("Notifications") {
                StatusRow(title: "Status", value: model.notifications.authorized ? "Allowed" : "Off", state: model.notifications.authorized ? .ok : .neutral)
                if !model.notifications.authorized {
                    Button("Turn On Notifications") { Task { await model.notifications.requestAuthorization() } }
                }
                LabeledContent("Remote push", value: model.env.pushEnabled ? "Enabled" : "Needs paid Apple Developer Program")
            }

            Section {
                Button("Privacy Summary") { showPrivacy = true }
                Button("Delete My Account", role: .destructive) { confirmDelete = true }
            } header: {
                Text("Privacy & Data")
            } footer: {
                Text("Raw GPS is deleted after 30 days. Simplified routes and stats stay until you delete them. Photos: 7 days if not confirmed, 30 days if confirmed (unless both operators keep them). Delete your data per night from History.")
            }

            Section {
                LabeledContent("Version", value: model.env.appVersion)
                LabeledContent("Server", value: model.env.apiBaseURL.host ?? "")
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
        } message: { Text("Removes your profile, friends, your operator tracks and photos. Other operators keep crew scores with your name anonymized.") }
        .errorAlert($error)
    }
}
