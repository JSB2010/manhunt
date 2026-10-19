import SwiftUI

/// Reusable roster templates ("Friday Manhunt").
struct GroupsView: View {
    @Environment(AppModel.self) private var model
    @State private var groups: [GroupsResponse.Group] = []
    @State private var editing: GroupsResponse.Group?
    @State private var creating = false
    @State private var error: String?
    @State private var busy = false
    @State private var loaded = false

    var body: some View {
        List {
            ForEach(groups) { g in
                Button { editing = g } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(g.name).font(.headline).foregroundStyle(.primary)
                        Text(g.people.map(\.displayName).formatted(.list(type: .and))).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .disabled(!g.canEdit)
                .swipeActions {
                    if g.isOwner { Button("Delete", systemImage: "trash", role: .destructive) { perform($busy, $error) { try await model.api.deleteGroup(g.id); await load() } } }
                }
            }
        }
        .overlay {
            if loaded && groups.isEmpty {
                ContentUnavailableView {
                    Label("No Groups", systemImage: "person.3.fill")
                } description: {
                    Text("Save your usual crew pool to set up nights faster.")
                } actions: {
                    Button("New Group") { creating = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Groups")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Label("New Group", systemImage: "plus") }
            }
        }
        .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) { GroupEditor(group: nil) }
        .sheet(item: $editing, onDismiss: { Task { await load() } }) { GroupEditor(group: $0) }
        .task { await load() }
        .errorAlert($error)
    }

    private func load() async {
        groups = (try? await model.api.groups().groups) ?? []
        loaded = true
    }
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
                } header: { Text("Share With Friends") } footer: { Text("Shared friends can see this group’s roster and use it for nights.") }
            }
            .navigationTitle(group == nil ? "New Group" : "Edit Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Save", busy: busy) {
                        perform($busy, $error) {
                            if let group {
                                try await model.api.updateGroup(group.id, name: name, personIds: Array(selectedPeople), memberUids: group.isOwner ? Array(selectedFriends) : nil)
                            } else {
                                _ = try await model.api.createGroup(name: name, personIds: Array(selectedPeople), memberUids: Array(selectedFriends))
                            }
                            dismiss()
                        }
                    }
                    .disabled(name.isEmpty)
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
