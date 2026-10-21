import SwiftUI

struct FriendsView: View {
    @Environment(AppModel.self) private var model
    @State private var friends: FriendsResponse?
    @State private var requests: FriendRequestsResponse?
    @State private var handle = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Friend’s handle", text: $handle)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .submitLabel(.send)
                        .onSubmit(sendRequest)
                    Button("Add", action: sendRequest)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(handle.count < 3 || busy)
                }
                if let link = model.me?.profile.friendInviteLink, let url = URL(string: link) {
                    ShareLink(item: url, message: Text("Add me on Manhunt Crews")) {
                        Label("Share My Friend Link", systemImage: "square.and.arrow.up")
                    }
                }
            } header: {
                Text("Add Friends")
            } footer: {
                Text("Friends never see your location.")
            }

            if let incoming = requests?.incoming, !incoming.isEmpty {
                Section("Requests") {
                    ForEach(incoming) { r in
                        HStack {
                            PersonLabel(name: r.user.displayName, handle: r.user.handle)
                            Spacer()
                            Button { respond(r.requestId, false) } label: { Label("Decline", systemImage: "xmark") }
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                                .labelStyle(.iconOnly)
                            Button { respond(r.requestId, true) } label: { Label("Accept", systemImage: "checkmark") }
                                .buttonStyle(.borderedProminent)
                                .buttonBorderShape(.circle)
                                .labelStyle(.iconOnly)
                        }
                    }
                }
            }

            if let outgoing = requests?.outgoing, !outgoing.isEmpty {
                Section("Sent") {
                    ForEach(outgoing) { r in
                        LabeledContent { Text("Pending") } label: { PersonLabel(name: r.user.displayName, handle: r.user.handle) }
                    }
                }
            }

            Section("Friends") {
                ForEach(friends?.friends ?? []) { f in
                    PersonLabel(name: f.displayName, handle: f.handle)
                        .swipeActions {
                            Button("Remove", systemImage: "person.badge.minus", role: .destructive) { remove(f) }
                            Button("Block", systemImage: "hand.raised.fill") { block(f) }.tint(.gray)
                        }
                        .contextMenu {
                            Button("Remove", systemImage: "person.badge.minus", role: .destructive) { remove(f) }
                            Button("Block", systemImage: "hand.raised.fill") { block(f) }
                        }
                }
                if friends != nil && (friends?.friends ?? []).isEmpty {
                    Text("No friends yet.")
                        .foregroundStyle(.secondary)
                }
            }

            if let blocked = friends?.blocked, !blocked.isEmpty {
                Section("Blocked") {
                    ForEach(blocked) { b in
                        HStack {
                            Text(b.displayName)
                            Spacer()
                            Button("Unblock") { perform($busy, $error) { try await model.api.unblock(b.uid); await load() } }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                    }
                }
            }
        }
        .navigationTitle("Friends")
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($error)
    }

    private func load() async {
        async let f = model.api.friends()
        async let r = model.api.friendRequests()
        friends = try? await f
        requests = try? await r
        await model.refreshMe()
    }

    private func sendRequest() {
        guard handle.count >= 3, !busy else { return }
        perform($busy, $error) {
            let r = try await model.api.sendFriendRequest(handle: handle.lowercased().trimmingCharacters(in: .whitespaces))
            model.show(r.status == "ACCEPTED" ? "You’re now friends" : r.status == "ALREADY_FRIENDS" ? "Already friends" : "Request sent")
            handle = ""
            await load()
        }
    }

    private func respond(_ id: String, _ accept: Bool) {
        perform($busy, $error) { try await model.api.respondFriendRequest(id, accept: accept); await load() }
    }

    private func remove(_ f: PublicProfile) {
        perform($busy, $error) { try await model.api.removeFriend(f.uid); await load() }
    }

    private func block(_ f: PublicProfile) {
        perform($busy, $error) { try await model.api.block(f.uid); await load() }
    }
}

/// Name with @handle underneath.
struct PersonLabel: View {
    let name: String
    let handle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
            if let handle { Text("@\(handle)").font(.subheadline).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }
}
