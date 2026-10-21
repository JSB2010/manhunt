import SwiftUI

/// First-run profile: the name crews see, and the unique @handle friends use to add you.
struct ProfileSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var handle = ""
    @State private var handleError: String?
    @State private var busy = false
    @State private var error: String?
    @State private var confirmSignOut = false
    @FocusState private var focus: Field?

    enum Field { case name, handle }

    private static let handleLength = 3...24
    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var handleValid: Bool { Self.handleLength.contains(handle.count) }
    private var canContinue: Bool { !trimmedName.isEmpty && handleValid && !busy }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ProfilePreview(name: trimmedName, handle: handle)
                        .listRowBackground(Color.clear)
                }

                Section {
                    TextField("Your name", text: $name)
                        .textContentType(.name)
                        .textInputAutocapitalization(.words)
                        .focused($focus, equals: .name)
                        .submitLabel(.next)
                        .onSubmit { focus = .handle }
                } header: {
                    Text("Name")
                }

                Section {
                    HStack(spacing: 2) {
                        Text("@").foregroundStyle(.secondary)
                        TextField("handle", text: $handle)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textContentType(.username)
                            .focused($focus, equals: .handle)
                            .submitLabel(.done)
                            .onSubmit { if canContinue { save() } }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Handle")
                } header: {
                    Text("Handle")
                } footer: {
                    if let handleError {
                        Label(handleError, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                    } else {
                        Text("3–24 characters: a–z, 0–9, . or _")
                    }
                }
            }
            .navigationTitle("Set Up Your Profile")
            .navigationSubtitleCompat(model.me?.profile.email.map { "Signed in as \($0)" })
            .onChange(of: handle) { _, new in
                // Keep the field to what the server accepts as you type.
                let cleaned = String(new.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == ".") }.prefix(Self.handleLength.upperBound))
                if cleaned != new { handle = cleaned }
                handleError = nil
            }
            .bottomActionBar {
                VStack(spacing: 10) {
                    Button(action: save) {
                        ActionLabel(title: "Continue", busy: busy)
                    }
                    .floatingProminentButton()
                    .controlSize(.large)
                    .disabled(!canContinue)

                    HStack(spacing: 4) {
                        Text("Not you?").foregroundStyle(.secondary)
                        Button("Sign Out") { confirmSignOut = true }
                            .buttonStyle(.borderless)
                    }
                    .font(.footnote)
                }
            }
            .confirmationDialog("Sign out and use a different account?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
            }
            .onAppear(perform: prefill)
            .errorAlert($error)
        }
    }

    private func prefill() {
        guard name.isEmpty else { return }
        name = model.auth.displayName ?? model.me?.profile.displayName ?? ""
        if handle.isEmpty {
            handle = String(name.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(Self.handleLength.upperBound))
        }
    }

    private func save() {
        guard canContinue else { return }
        focus = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                model.me = try await model.api.patchMe(displayName: trimmedName, handle: handle)
            } catch let e as APIError where e.code == "CONFLICT" || e.code == "VALIDATION_FAILED" {
                // Taken or reserved: say so next to the field instead of in an alert.
                handleError = e.code == "CONFLICT" ? "@\(handle) is taken. Try another handle." : e.localizedDescription
                focus = .handle
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// How friends will see you — updates as you type.
private struct ProfilePreview: View {
    let name: String
    let handle: String
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 72

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }

    var body: some View {
        VStack(spacing: 8) {
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(Color.accentColor, in: Circle())
                .accessibilityHidden(true)
            Text(name.isEmpty ? "Your Name" : name)
                .font(.title2.bold())
                .foregroundStyle(name.isEmpty ? .tertiary : .primary)
            Text(handle.isEmpty ? "@handle" : "@\(handle)")
                .font(.body)
                .foregroundStyle(handle.isEmpty ? .tertiary : .secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Preview: \(name.isEmpty ? "no name yet" : name), handle \(handle.isEmpty ? "not set" : handle)")
    }
}
