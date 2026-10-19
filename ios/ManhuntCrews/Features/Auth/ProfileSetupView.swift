import SwiftUI

/// First-run profile: display name + unique handle used for friend invites.
struct ProfileSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var handle = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Display name", text: $name)
                        .textContentType(.nickname)
                    TextField("Handle", text: $handle, prompt: Text("letters, numbers, _ or ."))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Friends find you by handle. Your location is never discoverable — friendship doesn’t grant location access.")
                }
                Section {
                    Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                }
            }
            .navigationTitle("Set Up Your Profile")
            .bottomActionBar {
                Button {
                    perform($busy, $error) {
                        model.me = try await model.api.patchMe(displayName: name.isEmpty ? nil : name, handle: handle.lowercased())
                    }
                } label: {
                    ActionLabel(title: "Continue", busy: busy)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(handle.count < 3 || busy)
            }
            .onAppear {
                name = model.me?.profile.displayName ?? ""
                if handle.isEmpty { handle = name.lowercased().filter { $0.isLetter || $0.isNumber } }
            }
            .errorAlert($error)
        }
    }
}
