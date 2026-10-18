import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showCreate = false
    @State private var showJoin = false
    @State private var joinCode = ""
    @State private var friendToken: String?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let notice = model.location.interruptedResumeNotice {
                        Card {
                            Label("Tracking interrupted", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(.orange)
                            Text(notice).font(.callout)
                            Button("OK") { model.location.dismissResumeNotice() }
                        }
                    }

                    if let active = model.me?.activeSessions, !active.isEmpty {
                        Text("Resume").font(.headline)
                        ForEach(active) { s in
                            Button { model.openSession(s.id) } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(s.title).font(.title3.weight(.bold))
                                        Text(s.status == "IN_ROUND" ? "Round in progress" : s.status == "LOBBY" ? "In lobby" : "Between rounds")
                                            .foregroundStyle(s.status == "IN_ROUND" ? Theme.seeking : .secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right.circle.fill").font(.title)
                                }
                                .padding()
                                .background(Theme.seeking.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.corner))
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    if let invites = model.me?.pendingSessionInvites, !invites.isEmpty {
                        Text("Invitations").font(.headline)
                        ForEach(invites) { inv in
                            Card {
                                Text(inv.sessionTitle).font(.headline)
                                Text("\(inv.hostDisplayName ?? "A friend") invited you to operate \(inv.teamName)").font(.callout)
                                Button("Review & join") { showJoin = true; joinCode = ""; pendingInviteId = inv.inviteId }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                    }

                    HStack(spacing: 12) {
                        BigButton(title: "Create night", systemImage: "plus.circle.fill") { showCreate = true }
                        BigButton(title: "Join night", systemImage: "qrcode", tint: Theme.hiding) { showJoin = true }
                    }

                    VStack(spacing: 0) {
                        NavigationLink { HistoryView() } label: { HomeRow(title: "History & stats", icon: "clock.arrow.circlepath") }
                        Divider()
                        NavigationLink { FriendsView() } label: {
                            HomeRow(title: "Friends", icon: "person.2.fill", badge: model.me?.counts.incomingFriendRequests ?? 0)
                        }
                        Divider()
                        NavigationLink { PeopleView() } label: { HomeRow(title: "People", icon: "person.text.rectangle") }
                        Divider()
                        NavigationLink { GroupsView() } label: { HomeRow(title: "Saved groups", icon: "person.3.sequence.fill") }
                        Divider()
                        NavigationLink { SettingsView() } label: { HomeRow(title: "Settings & privacy", icon: "gearshape.fill") }
                    }
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.corner))

                    Label("Exactly two tracking iPhones per night: one operator per crew. Teammates don't need the app.", systemImage: "iphone.gen3")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle("Hi, \(model.me?.profile.displayName ?? "")")
            .refreshable { await model.refreshMe() }
            .sheet(isPresented: $showCreate) { CreateNightView() }
            .sheet(isPresented: $showJoin, onDismiss: { pendingInviteId = nil }) { JoinNightView(initialCode: joinCode, inviteId: pendingInviteId) }
            .alert("Add friend?", isPresented: Binding(get: { friendToken != nil }, set: { if !$0 { friendToken = nil } })) {
                Button("Send request") {
                    let token = friendToken
                    perform($busy, $error) {
                        let r = try await model.api.sendFriendRequest(token: token)
                        model.show(r.status == "ACCEPTED" ? "You're now friends" : "Friend request sent")
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

    @State private var pendingInviteId: String?

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

private struct HomeRow: View {
    let title: String
    let icon: String
    var badge = 0
    var body: some View {
        HStack {
            Image(systemName: icon).frame(width: 28).foregroundStyle(.tint)
            Text(title).font(.body.weight(.medium))
            Spacer()
            if badge > 0 {
                Text("\(badge)").font(.caption.bold()).padding(6).background(Theme.seeking, in: Circle()).foregroundStyle(.white)
            }
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding()
        .contentShape(Rectangle())
    }
}
