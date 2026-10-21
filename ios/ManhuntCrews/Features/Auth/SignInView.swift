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
    @FocusState private var focus: Field?

    enum Mode: String, CaseIterable { case signIn = "Sign In", signUp = "Create Account" }
    enum Field { case name, email, password }

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty && !busy }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    VStack(spacing: 12) {
                        BrandMark()
                        Text("Manhunt Crews")
                            .font(.largeTitle.bold())
                        Text("Scheduled pings. Photo catches. Crew stats.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 24)

                    VStack(spacing: 16) {
                        if model.env.appleSignInEnabled {
                            SignInWithAppleButton(.continue) { request in
                                model.auth.prepareAppleRequest(request)
                            } onCompletion: { result in
                                perform($busy, $error) { try await model.auth.completeApple(result) }
                            }
                            .signInWithAppleButtonStyle(.black)
                            .frame(height: 50)
                            .clipShape(Capsule())
                            Text("or use email").font(.footnote).foregroundStyle(.secondary)
                        }

                        Picker("Account", selection: $mode) {
                            ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)

                        VStack(spacing: 0) {
                            if mode == .signUp {
                                field {
                                    TextField("Display name", text: $displayName)
                                        .textContentType(.nickname)
                                        .focused($focus, equals: .name)
                                        .submitLabel(.next)
                                        .onSubmit { focus = .email }
                                }
                                Divider().padding(.leading)
                            }
                            field {
                                TextField("Email", text: $email)
                                    .accessibilityIdentifier("signin.email")
                                    .keyboardType(.emailAddress)
                                    .textContentType(.username)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .focused($focus, equals: .email)
                                    .submitLabel(.next)
                                    .onSubmit { focus = .password }
                            }
                            Divider().padding(.leading)
                            field {
                                SecureField(mode == .signUp ? "Password (8+ characters)" : "Password", text: $password)
                                    .accessibilityIdentifier("signin.password")
                                    .textContentType(mode == .signUp ? .newPassword : .password)
                                    .focused($focus, equals: .password)
                                    .submitLabel(.go)
                                    .onSubmit { if canSubmit { submit() } }
                            }
                        }
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                        Button(action: submit) {
                            ActionLabel(title: mode.rawValue, busy: busy)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("signin.submit")

                        if mode == .signIn {
                            Button("Forgot Password?") {
                                perform($busy, $error) {
                                    try await model.auth.sendPasswordReset(email: email)
                                    model.show("Password reset email sent")
                                }
                            }
                            .font(.subheadline)
                            .disabled(email.isEmpty)
                        }
                    }

                    VStack(spacing: 12) {
                        if model.env.useEmulators {
                            Label("Development build using local emulators (\(model.env.devHost)). No production data.", systemImage: "hammer.fill")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        Button("How Manhunt Crews Uses Your Data") { showPrivacy = true }
                            .font(.footnote)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemGroupedBackground))
            .animation(.snappy, value: mode)
            .sheet(isPresented: $showPrivacy) { PrivacySummaryView() }
            .errorAlert($error)
        }
    }

    private func field(@ViewBuilder _ content: () -> some View) -> some View {
        content()
            .padding(.horizontal)
            .frame(minHeight: 50)
    }

    private func submit() {
        focus = nil
        perform($busy, $error) {
            if mode == .signUp {
                guard !displayName.trimmingCharacters(in: .whitespaces).isEmpty else { throw SimpleError("Enter a display name.") }
                guard password.count >= 8 else { throw SimpleError("Use at least 8 characters for your password.") }
                try await model.auth.signUp(email: email, password: password, displayName: displayName)
            } else {
                try await model.auth.signIn(email: email, password: password)
            }
        }
    }
}

/// The app’s mark — a hider’s dotted trail ending at a released ping — echoing the
/// app icon. Decorative.
private struct BrandMark: View {
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 84

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
            Canvas { ctx, canvas in
                let s = canvas.width
                let trail = [CGPoint(x: 0.18, y: 0.76), CGPoint(x: 0.3, y: 0.76), CGPoint(x: 0.4, y: 0.68),
                             CGPoint(x: 0.47, y: 0.58), CGPoint(x: 0.55, y: 0.5)]
                for p in trail {
                    ctx.fill(Path(ellipseIn: CGRect(x: p.x * s - s * 0.035, y: p.y * s - s * 0.035, width: s * 0.07, height: s * 0.07)),
                             with: .color(Theme.crew(.A)))
                }
            }
            Image(systemName: "mappin")
                .font(.system(size: size * 0.46, weight: .bold))
                .foregroundStyle(Theme.crew(.B))
                .offset(x: size * 0.14, y: -size * 0.08)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
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
                Section("While You Play") {
                    Label("Each crew’s operator phones are tracked only during rounds you start, plus the ready check.", systemImage: "iphone.gen3.radiowaves.left.and.right")
                    Label("Other crews get only scheduled pings, never your live location or route.", systemImage: "eye.slash.fill")
                }
                Section("After a Round") {
                    Label("The round’s phones see its pings, distances and catch photo, and its routes if everyone in the round agreed.", systemImage: "map.fill")
                    Label("Crew rosters and catch photos are saved too, so let teammates without the app know.", systemImage: "person.3.fill")
                }
                Section("Retention and Deletion") {
                    Label("Raw GPS: 30 days. Routes and stats: until deleted. Photos: 7 days if unconfirmed; 30 days if confirmed, unless every crew keeps them.", systemImage: "clock.arrow.circlepath")
                    Label("Delete your tracks and photos from any night, a night you organized, or your whole account in Settings.", systemImage: "trash")
                }
            }
            .labelStyle(PrivacyLabelStyle())
            .navigationTitle("Privacy")
            .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } } }
        }
    }
}

/// List label with a tinted leading symbol aligned to the first line of text.
private struct PrivacyLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            configuration.icon.foregroundStyle(.tint).frame(minWidth: 24)
            configuration.title
        }
    }
}
