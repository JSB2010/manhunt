import SwiftUI

/// Play tab: resume tonight’s night, answer invitations, or start a new one.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showCreate = false
    @State private var showJoin = false
    @State private var showSettings = false
    @State private var joinCode = ""
    @State private var pendingInviteId: String?
    @State private var friendToken: String?
    @State private var error: String?
    @State private var busy = false

    private var active: [MeResponse.ActiveSession] { model.me?.activeSessions ?? [] }
    private var invites: [MeResponse.PendingInvite] { model.me?.pendingSessionInvites ?? [] }

    var body: some View {
        NavigationStack {
            List {
                if model.location.interruptedResumeNotice != nil {
                    Section {
                        InlineNotice(message: "Tracking was interrupted and has resumed.", actionTitle: "Dismiss") {
                            model.location.dismissResumeNotice()
                        }
                    }
                }

                if !active.isEmpty {
                    Section("Tonight") {
                        ForEach(active) { s in
                            Button { model.openSession(s.id) } label: { ResumeRow(session: s) }
                                .tint(.primary)
                                .accessibilityHint("Opens the night")
                        }
                    }
                }

                if !invites.isEmpty {
                    Section("Invitations") {
                        ForEach(invites) { inv in
                            InvitationRow(invite: inv) {
                                joinCode = ""
                                pendingInviteId = inv.inviteId
                                showJoin = true
                            }
                        }
                    }
                }

                Section {
                    VStack(spacing: 12) {
                        Button { showCreate = true } label: { ActionLabel(title: "Create a Night", systemImage: "plus") }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("home.create")
                        Button { showJoin = true } label: { ActionLabel(title: "Join with a Code", systemImage: "qrcode") }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("home.join")
                    }
                    .controlSize(.large)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
            }
            .listSectionSpacing(.compact)
            .navigationTitle("Play")
            .navigationSubtitleCompat(model.me.map { "Signed in as \($0.profile.displayName)" })
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: {
                        Label("Account & Settings", systemImage: "person.crop.circle")
                    }
                    .accessibilityIdentifier("home.settings")
                }
            }
            .refreshable { await model.refreshMe() }
            .sheet(isPresented: $showCreate) { CreateNightView() }
            .sheet(isPresented: $showJoin, onDismiss: { pendingInviteId = nil }) {
                JoinNightView(initialCode: joinCode, inviteId: pendingInviteId)
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    SettingsView()
                        .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { showSettings = false } } }
                }
            }
            .alert("Add Friend?", isPresented: Binding(get: { friendToken != nil }, set: { if !$0 { friendToken = nil } })) {
                Button("Send Request") {
                    let token = friendToken
                    perform($busy, $error) {
                        let r = try await model.api.sendFriendRequest(token: token)
                        model.show(r.status == "ACCEPTED" ? "You’re now friends" : "Friend request sent")
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Someone shared their Manhunt Crews friend link with you.")
            }
            .onChange(of: model.pendingDeepLink) { _, link in handle(link) }
            .onAppear { handle(model.pendingDeepLink) }
            .errorAlert($error)
        }
    }

    private func handle(_ link: DeepLink?) {
        guard let link else { return }
        model.pendingDeepLink = nil
        switch link {
        case let .join(code):
            joinCode = code
            showJoin = true
        case let .friend(token):
            friendToken = token
        }
    }
}

private struct ResumeRow: View {
    let session: MeResponse.ActiveSession

    private var status: (String, String) {
        switch session.status {
        case "IN_ROUND": ("Round in progress", "record.circle")
        case "LOBBY": ("In the lobby", "person.2.fill")
        default: ("Between rounds", "arrow.triangle.2.circlepath")
        }
    }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: status.1)
                .font(.title2)
                .foregroundStyle(Color.accentColor)
                .symbolRenderingMode(.hierarchical)
                .frame(minWidth: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).font(.headline).foregroundStyle(.primary)
                Text(status.0).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct InvitationRow: View {
    let invite: MeResponse.PendingInvite
    let review: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(invite.sessionTitle).font(.headline)
                Text("\(invite.hostDisplayName ?? "A friend") invited you")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button("Review & Join", action: review)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.vertical, 4)
    }
}

extension View {
    /// Navigation subtitle on iOS 26+; earlier systems show the title alone.
    @ViewBuilder
    func navigationSubtitleCompat(_ subtitle: String?) -> some View {
        if #available(iOS 26, *), let subtitle {
            navigationSubtitle(subtitle)
        } else {
            self
        }
    }
}
