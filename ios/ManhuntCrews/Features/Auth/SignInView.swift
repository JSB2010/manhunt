import SwiftUI
import AuthenticationServices

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showPrivacy = false

    enum Mode: String, CaseIterable { case signIn = "Sign in", signUp = "Create account" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    VStack(spacing: 8) {
                        Image(systemName: "mappin.and.ellipse")
                            .font(.system(size: 56, weight: .bold))
                            .foregroundStyle(Theme.seeking)
                        Text("Manhunt Crews").font(.largeTitle.weight(.heavy))
                        Text("Two crews. One phone each. Scheduled pings, photo catches, honest stats.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 32)

                    if model.env.appleSignInEnabled {
                        SignInWithAppleButton(.continue) { request in
                            model.auth.prepareAppleRequest(request)
                        } onCompletion: { result in
                            perform($busy, $error) { try await model.auth.completeApple(result) }
                        }
                        .signInWithAppleButtonStyle(.black)
                        .frame(height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        Text("or use email").font(.footnote).foregroundStyle(.secondary)
                    }

                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    VStack(spacing: 12) {
                        if mode == .signUp {
                            TextField("Display name (e.g. Morgan)", text: $displayName)
                                .textContentType(.nickname)
                                .textFieldStyle(.roundedBorder)
                        }
                        TextField("Email", text: $email)
                            .accessibilityIdentifier("signin.email")
                            .keyboardType(.emailAddress)
                            .textContentType(.username)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                        SecureField("Password (8+ characters)", text: $password)
                            .accessibilityIdentifier("signin.password")
                            .textContentType(mode == .signUp ? .newPassword : .password)
                            .textFieldStyle(.roundedBorder)
                    }
                    .font(.title3)

                    BigButton(title: mode.rawValue, systemImage: "person.badge.key", busy: busy) {
                        perform($busy, $error) {
                            if mode == .signUp {
                                guard !displayName.trimmingCharacters(in: .whitespaces).isEmpty else { throw SimpleError("Enter a display name") }
                                guard password.count >= 8 else { throw SimpleError("Use at least 8 characters") }
                                try await model.auth.signUp(email: email, password: password, displayName: displayName)
                            } else {
                                try await model.auth.signIn(email: email, password: password)
                            }
                        }
                    }
                    .disabled(email.isEmpty || password.isEmpty)
                    .accessibilityIdentifier("signin.submit")

                    if mode == .signIn {
                        Button("Forgot password?") {
                            perform($busy, $error) {
                                try await model.auth.sendPasswordReset(email: email)
                                model.show("Password reset email sent")
                            }
                        }
                        .font(.footnote)
                        .disabled(email.isEmpty)
                    }

                    if model.env.useEmulators {
                        Label("Development build — local emulators (\(model.env.devHost)). No production data.", systemImage: "hammer")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }

                    Button("Privacy summary") { showPrivacy = true }.font(.footnote)
                }
                .padding()
            }
            .sheet(isPresented: $showPrivacy) { PrivacySummaryView() }
            .errorAlert($error)
        }
    }
}

struct SimpleError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

struct PrivacySummaryView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section("What is recorded") {
                    Text("Only the two crew operator phones are tracked, and only during a round you explicitly start (plus a short ready check). Tracking stops when the round ends.")
                    Text("Your crew’s exact route is hidden from the other crew while playing. They only receive scheduled location pings.")
                    Text("After each round, both operators can see both routes, pings, distances and the catch photo.")
                }
                Section("Teammates without the app") {
                    Text("Make sure your crew knows the operator phone’s location, the crew roster and catch photos are recorded and shown to both operators after rounds.")
                }
                Section("Retention and deletion") {
                    Text("Raw GPS samples: up to 30 days. Simplified routes and stats: until the night is deleted or you delete your data. Rejected photos: 7 days; confirmed photos: 30 days unless both operators keep them.")
                    Text("You can delete your own tracks and photos from any night, delete a night you organized, or delete your account in Settings.")
                }
                Section("Honesty about GPS") {
                    Text("iOS may delay or pause background location, and a force-quit stops tracking. Missing fixes are shown as missing, never invented. Notifications can be late; the app’s clock comes from the server.")
                }
            }
            .navigationTitle("Privacy")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
