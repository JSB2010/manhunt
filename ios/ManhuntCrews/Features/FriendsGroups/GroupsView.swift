import SwiftUI

/// Reusable roster templates ("Friday Manhunt").
struct GroupsView: View {
    @Environment(AppModel.self) private var model
    @State private var groups: [GroupsResponse.Group] = []
    @State private var editing: GroupsResponse.Group?
    @State private var creating = false
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            ForEach(groups) { g in
                Button { editing = g } label: {
                    VStack(alignment: .leading) {
                        Text(g.name).font(.headline)
                        Text(g.people.map(\.displayName).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .disabled(!g.canEdit)
                .swipeActions {
                    if g.isOwner { Button("Delete", role: .destructive) { perform($busy, $error) { try await model.api.deleteGroup(g.id); await load() } } }
                }
            }
            if groups.isEmpty { ContentUnavailableView("No groups", systemImage: "person.3", description: Text("Save your usual crew pool to set up nights faster.")) }
        }
        .navigationTitle("Saved groups")
        .toolbar { Button { creating = true } label: { Image(systemName: "plus") } }
        .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) { GroupEditor(group: nil) }
        .sheet(item: $editing, onDismiss: { Task { await load() } }) { GroupEditor(group: $0) }
        .task { await load() }
        .errorAlert($error)
    }

    private func load() async { groups = (try? await model.api.groups().groups) ?? [] }
}

struct GroupEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let group: GroupsResponse.Group?
    @State private var name = ""
    @State private var people: [Person] = []
    @State private var selectedPeople: Set<String> = []
    @State private var friends: [PublicProfile] = []
    @State private var selectedFriends: Set<String> = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("e.g. Friday Manhunt", text: $name) }
                Section("People") {
                    ForEach(people) { p in
                        Toggle(p.displayName, isOn: Binding(get: { selectedPeople.contains(p.id) }, set: { if $0 { selectedPeople.insert(p.id) } else { selectedPeople.remove(p.id) } }))
                    }
                }
                Section {
                    ForEach(friends) { f in
                        Toggle(f.displayName, isOn: Binding(get: { selectedFriends.contains(f.uid) }, set: { if $0 { selectedFriends.insert(f.uid) } else { selectedFriends.remove(f.uid) } }))
                    }
                } header: { Text("Share with friends") } footer: { Text("Shared friends can see this group's roster and use it for nights.") }
            }
            .navigationTitle(group == nil ? "New group" : "Edit group")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        perform($busy, $error) {
                            if let group {
                                try await model.api.updateGroup(group.id, name: name, personIds: Array(selectedPeople), memberUids: group.isOwner ? Array(selectedFriends) : nil)
                            } else {
                                _ = try await model.api.createGroup(name: name, personIds: Array(selectedPeople), memberUids: Array(selectedFriends))
                            }
                            dismiss()
                        }
                    }
                    .disabled(name.isEmpty || busy)
                }
            }
            .task {
                people = (try? await model.api.people().people) ?? []
                friends = (try? await model.api.friends().friends) ?? []
                if let group {
                    name = group.name
                    selectedPeople = Set(group.people.map(\.id))
                    selectedFriends = Set(group.memberUids.filter { $0 != model.auth.uid })
                }
            }
            .errorAlert($error)
        }
    }
}
