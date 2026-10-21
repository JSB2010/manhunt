import Foundation
import Observation
import FirebaseAuth
import AuthenticationServices
import CryptoKit

/// Firebase Authentication wrapper. Email/password is the explicit
/// DEV_AUTH_PROVIDER for free Personal Team builds; Sign in with Apple is
/// feature-gated until the paid Apple Developer Program entitlement exists.
/// Firebase stores its tokens in the Keychain; the stable UID survives linking.
@MainActor
@Observable
final class AuthService {
    enum State: Equatable { case unknown, signedOut, signedIn(uid: String, email: String?) }

    /// Driven by the Firebase listener (and set at once on sign-out); tests set it directly.
    var state: State = .unknown
    /// Called when the signed-in account goes away or changes without `signOut()`
    /// (Firebase signs out by force on a revoked token), so cached tokens never
    /// outlive their account. Not called on sign-in, where there is nothing to drop.
    var onAccountEnded: (() -> Void)?
    private var handle: AuthStateDidChangeListenerHandle?
    private var currentNonce: String?
    let env: AppEnvironment

    init(env: AppEnvironment) {
        self.env = env
    }

    func start() {
        guard handle == nil else { return }
        handle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                guard let self else { return }
                let previous = self.uid
                if let user { self.state = .signedIn(uid: user.uid, email: user.email) } else { self.state = .signedOut }
                if previous != nil, previous != user?.uid { self.onAccountEnded?() }
            }
        }
    }

    var uid: String? {
        if case let .signedIn(uid, _) = state { return uid }
        return nil
    }

    /// The name entered at sign-up. The server can provision the profile before
    /// this reaches the ID token, so first-run setup prefers it.
    var displayName: String? {
        let name = Auth.auth().currentUser?.displayName?.trimmingCharacters(in: .whitespaces)
        return name?.isEmpty == false ? name : nil
    }

    /// Raw Firebase token fetch. Callers go through `TokenBroker`, which coalesces
    /// refreshes and maps Firebase errors (only definitive ones end the session).
    nonisolated func idToken(forceRefresh: Bool) async throws -> String {
        guard let user = Auth.auth().currentUser else { throw APIError.unauthenticated }
        return try await user.getIDToken(forcingRefresh: forceRefresh)
    }

    func signIn(email: String, password: String) async throws {
        _ = try await Auth.auth().signIn(withEmail: email.trimmingCharacters(in: .whitespaces), password: password)
    }

    func signUp(email: String, password: String, displayName: String) async throws {
        let result = try await Auth.auth().createUser(withEmail: email.trimmingCharacters(in: .whitespaces), password: password)
        let change = result.user.createProfileChangeRequest()
        change.displayName = displayName
        try await change.commitChanges()
        // Refresh so the ID token carries the display name for first-time provisioning.
        _ = try await result.user.getIDToken(forcingRefresh: true)
    }

    func sendPasswordReset(email: String) async throws {
        try await Auth.auth().sendPasswordReset(withEmail: email)
    }

    /// Signed out as far as the app is concerned even if Firebase's keychain
    /// cleanup throws; the listener's later `.signedOut` is then a no-op.
    func signOut() throws {
        defer { state = .signedOut }
        try Auth.auth().signOut()
    }

    // MARK: Sign in with Apple (requires paid membership + entitlement)

    func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomNonce()
        currentNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)
    }

    func completeApple(_ result: Result<ASAuthorization, Error>) async throws {
        let auth = try result.get()
        guard let cred = auth.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken, let idToken = String(data: tokenData, encoding: .utf8),
              let nonce = currentNonce else { throw APIError.unauthenticated }
        let credential = OAuthProvider.appleCredential(withIDToken: idToken, rawNonce: nonce, fullName: cred.fullName)
        if let user = Auth.auth().currentUser {
            // Keep the same UID when an email/password account adds Apple sign-in.
            _ = try await user.link(with: credential)
        } else {
            _ = try await Auth.auth().signIn(with: credential)
        }
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    private static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
