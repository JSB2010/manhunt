import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                ToastView(text: toast)
                    .padding(.top, 8)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? .none : .snappy, value: model.toast)
        .onChange(of: model.toast) { _, toast in
            if let toast { AccessibilityNotification.Announcement(toast).post() }
        }
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
                    MainTabView()
                        .fullScreenCover(isPresented: Binding(get: { model.activeSessionId != nil }, set: { if !$0 { model.closeSession() } })) {
                            SessionContainerView()
                                .environment(model)
                        }
                }
            } else if let err = model.meError {
                ContentUnavailableView {
                    Label("Can’t Reach the Game Server", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(err)
                } actions: {
                    Button("Try Again") { Task { await model.refreshMe() } }
                        .buttonStyle(.borderedProminent)
                    Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                }
            } else {
                ProgressView("Loading your account…")
            }
        }
        .task { await model.onSignedIn() }
    }
}

/// Top-level sections (HIG › Tab bars): Play, History, Friends, People. Account and
/// settings live behind the profile button on Play, as in Apple’s own apps.
private struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @State private var tab: AppTab = .play

    enum AppTab: Hashable { case play, history, friends, people }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Play", systemImage: "flag.2.crossed.fill", value: AppTab.play) {
                HomeView()
            }
            Tab("History", systemImage: "clock.arrow.circlepath", value: AppTab.history) {
                NavigationStack { HistoryView() }
            }
            Tab("Friends", systemImage: "person.2.fill", value: AppTab.friends) {
                NavigationStack { FriendsView() }
            }
            .badge(model.me?.counts.incomingFriendRequests ?? 0)
            Tab("People", systemImage: "person.text.rectangle.fill", value: AppTab.people) {
                NavigationStack { PeopleAndGroupsView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }
}

struct ConfigurationErrorView: View {
    let message: String
    var body: some View {
        ContentUnavailableView {
            Label("App Not Configured", systemImage: "gearshape.2")
        } description: {
            Text(message)
            Text("See docs/apple-distribution.md and scripts/setup-firebase.md.").font(.footnote)
        }
    }
}
