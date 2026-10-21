import SwiftUI

/// Edits a crew roster as stable person references. New names are created as
/// saved people first (with duplicate detection) so history never relies on
/// free text alone.
struct RosterEditor: View {
    @Environment(AppModel.self) private var model
    let title: String
    @Binding var roster: [RosterEntryBody]
    /// People already on another crew (nobody is on two).
    var excluded: Set<String> = []
    var groupPeople: [Person] = []

    @State private var newName = ""
    @State private var duplicates: [Person] = []
    @State private var pendingName = ""
    @State private var showPicker = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Section {
            ForEach(roster, id: \.self) { entry in
                Label {
                    Text(entry.displayName)
                } icon: {
                    Image(systemName: entry.personId == model.me?.profile.selfPersonId ? "person.crop.circle.badge.checkmark" : "person.fill")
                        .foregroundStyle(.secondary)
                }
            }
            .onDelete { roster.remove(atOffsets: $0) }
            HStack {
                TextField("Add a name", text: $newName)
                    .submitLabel(.done)
                    .onSubmit(add)
                Button(action: add) { Label("Add", systemImage: "plus.circle.fill").labelStyle(.iconOnly).font(.title3) }
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || busy)
            }
            Button("Choose Saved People…") { showPicker = true }
        } header: {
            Text(title)
        }
        .sheet(isPresented: $showPicker) {
            PeoplePicker(selected: Set(roster.compactMap(\.personId)), excluded: excluded, groupPeople: groupPeople) { picked in
                for p in picked where !roster.contains(where: { $0.personId == p.id }) {
                    roster.append(.init(personId: p.id, displayName: p.displayName))
                }
            }
        }
        .confirmationDialog("Is this someone you already saved?", isPresented: Binding(get: { !duplicates.isEmpty }, set: { if !$0 { duplicates = [] } }), titleVisibility: .visible) {
            ForEach(duplicates) { p in
                Button("Use saved \(p.displayName)\(p.hasAccount ? " (has account)" : "")") { append(p) }
            }
            Button("No — Create a New \(pendingName)") { create(confirm: true) }
            Button("Cancel", role: .cancel) {}
        }
        .errorAlert($error)
    }

    private func add() {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        pendingName = name
        create(confirm: false)
    }

    private func create(confirm: Bool) {
        perform($busy, $error) {
            let r = try await model.api.createPerson(name: pendingName, confirmNew: confirm)
            if let p = r.person, r.created {
                append(p)
            } else {
                duplicates = r.possibleDuplicates.filter { !excluded.contains($0.id) }
                if duplicates.isEmpty { create(confirm: true) }
            }
        }
    }

    private func append(_ p: Person) {
        duplicates = []
        newName = ""
        guard !excluded.contains(p.id) else { error = "\(p.displayName) is already on another crew."; return }
        if !roster.contains(where: { $0.personId == p.id }) { roster.append(.init(personId: p.id, displayName: p.displayName)) }
    }
}

struct PeoplePicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let selected: Set<String>
    let excluded: Set<String>
    var groupPeople: [Person] = []
    let onDone: ([Person]) -> Void
    @State private var people: [Person] = []
    @State private var picked: Set<String> = []
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                if !groupPeople.isEmpty {
                    Section("From the Selected Group") { rows(groupPeople) }
                }
                Section("Saved People") { rows(people.filter { p in !groupPeople.contains(where: { $0.id == p.id }) }) }
            }
            .searchable(text: $query)
            .navigationTitle("Choose People")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Add") {
                        onDone((groupPeople + people).filter { picked.contains($0.id) }.reduce(into: [Person]()) { acc, p in if !acc.contains(p) { acc.append(p) } })
                        dismiss()
                    }
                }
            }
            .task(id: query) {
                people = (try? await model.api.people(query: query.isEmpty ? nil : query).people) ?? []
            }
        }
    }

    @ViewBuilder private func rows(_ list: [Person]) -> some View {
        ForEach(list.filter { query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query) }) { p in
            let disabled = excluded.contains(p.id) || selected.contains(p.id)
            Button {
                if picked.contains(p.id) { picked.remove(p.id) } else { picked.insert(p.id) }
            } label: {
                HStack {
                    Text(p.displayName)
                    if p.isSelf { Text("(you)").foregroundStyle(.secondary) }
                    if p.hasAccount && !p.isSelf { Image(systemName: "person.crop.circle.badge.checkmark").foregroundStyle(.secondary) }
                    Spacer()
                    if picked.contains(p.id) || selected.contains(p.id) { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Selected") }
                }
            }
            .disabled(disabled)
        }
    }
}
