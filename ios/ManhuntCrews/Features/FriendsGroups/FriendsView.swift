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
                    TextField("Friend's handle", text: $handle).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Add") {
                        perform($busy, $error) {
                            let r = try await model.api.sendFriendRequest(handle: handle.lowercased().trimmingCharacters(in: .whitespaces))
                            model.show(r.status == "ACCEPTED" ? "You're now friends" : r.status == "ALREADY_FRIENDS" ? "Already friends" : "Request sent")
                            handle = ""
                            await load()
                        }
                    }
                    .disabled(handle.count < 3 || busy)
                }
                if let link = model.me?.profile.friendInviteLink, let url = URL(string: link) {
                    ShareLink(item: url, message: Text("Add me on Manhunt Crews")) { Label("Share my friend link", systemImage: "square.and.arrow.up") }
                }
            } header: { Text("Add friends") } footer: {
                Text("Friends can be invited to nights and groups. Friendship never shares your location; there is no public map or directory.")
            }
            if let inc = requests?.incoming, !inc.isEmpty {
                Section("Requests") {
                    ForEach(inc) { r in
                        HStack {
                            VStack(alignment: .leading) { Text(r.user.displayName); Text("@\(r.user.handle ?? "")").font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            Button("Accept") { respond(r.requestId, true) }.buttonStyle(.borderedProminent)
                            Button("Decline") { respond(r.requestId, false) }.buttonStyle(.bordered)
                        }
                    }
                }
            }
            if let out = requests?.outgoing, !out.isEmpty {
                Section("Sent") { ForEach(out) { r in Text("\(r.user.displayName) (@\(r.user.handle ?? "")) — pending").foregroundStyle(.secondary) } }
            }
            Section("Friends") {
                ForEach(friends?.friends ?? []) { f in
                    VStack(alignment: .leading) { Text(f.displayName); Text("@\(f.handle ?? "")").font(.caption).foregroundStyle(.secondary) }
                        .swipeActions {
                            Button("Remove", role: .destructive) { perform($busy, $error) { try await model.api.removeFriend(f.uid); await load() } }
                            Button("Block") { perform($busy, $error) { try await model.api.block(f.uid); await load() } }.tint(.gray)
                        }
                }
                if (friends?.friends ?? []).isEmpty { Text("No friends yet").foregroundStyle(.secondary) }
            }
            if let blocked = friends?.blocked, !blocked.isEmpty {
                Section("Blocked") {
                    ForEach(blocked) { b in
                        HStack { Text(b.displayName); Spacer(); Button("Unblock") { perform($busy, $error) { try await model.api.unblock(b.uid); await load() } } }
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

    private func respond(_ id: String, _ accept: Bool) {
        perform($busy, $error) { try await model.api.respondFriendRequest(id, accept: accept); await load() }
    }
}
