import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let err = model.env.configurationError ?? model.firebaseError {
                ConfigurationErrorView(message: err)
            } else {
                switch model.auth.state {
                case .unknown:
                    ProgressView("Starting…")
                case .signedOut:
                    SignInView()
                case .signedIn:
                    SignedInRoot()
                }
            }
        }
        .overlay(alignment: .top) {
            if let toast = model.toast {
                Text(toast)
                    .font(.callout.weight(.semibold))
                    .padding(12)
                    .background(.thickMaterial, in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.default, value: model.toast)
    }
}

private struct SignedInRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let me = model.me {
                if me.profile.handle == nil {
                    ProfileSetupView()
                } else {
                    HomeView()
                        .fullScreenCover(isPresented: Binding(get: { model.activeSessionId != nil }, set: { if !$0 { model.closeSession() } })) {
                            SessionContainerView()
                                .environment(model)
                        }
                }
            } else if let err = model.meError {
                VStack(spacing: 16) {
                    ContentUnavailableView("Can't reach the game server", systemImage: "wifi.exclamationmark", description: Text(err))
                    Button("Retry") { Task { await model.refreshMe() } }.buttonStyle(.borderedProminent)
                    Button("Sign out", role: .destructive) { Task { await model.signOut() } }
                }
                .padding()
            } else {
                ProgressView("Loading your account…")
            }
        }
        .task { await model.onSignedIn() }
    }
}

struct ConfigurationErrorView: View {
    let message: String
    var body: some View {
        ContentUnavailableView {
            Label("App not configured", systemImage: "gearshape.2")
        } description: {
            Text(message)
            Text("See docs/apple-distribution.md and scripts/setup-firebase.md.").font(.footnote)
        }
    }
}
