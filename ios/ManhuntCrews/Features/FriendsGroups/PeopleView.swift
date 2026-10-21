import SwiftUI

/// People tab: saved people and reusable groups, switched with a segmented control.
struct PeopleAndGroupsView: View {
    enum Segment: String, CaseIterable { case people = "People", groups = "Groups" }
    @State private var segment: Segment = .people

    var body: some View {
        Group {
            switch segment {
            case .people: PeopleView()
            case .groups: GroupsView()
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Show", selection: $segment) {
                    ForEach(Segment.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
        }
    }
}

/// Saved people (guests and account holders) with stable identities.
struct PeopleView: View {
    @Environment(AppModel.self) private var model
    @State private var people: [Person] = []
    @State private var links: [LinkRequestsResponse.Item] = []
    @State private var query = ""
    @State private var newName = ""
    @State private var duplicates: [Person] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("New person’s name", text: $newName)
                        .textContentType(.name)
                        .submitLabel(.done)
                        .onSubmit { if !newName.trimmingCharacters(in: .whitespaces).isEmpty { create(confirm: false) } }
                    Button("Add") { create(confirm: false) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            } header: {
                Text("Add a Person")
            } footer: {
                Text("No account needed. Stats follow each person.")
            }
            if !links.isEmpty {
                Section("Account Link Requests") {
                    ForEach(links) { l in
                        VStack(alignment: .leading) {
                            Text("\(l.requester?.displayName ?? "Someone") says they are \(l.person?.displayName ?? "this person")")
                            HStack {
                                Button("Approve") { respond(l.requestId, true) }.buttonStyle(.borderedProminent)
                                Button("Decline") { respond(l.requestId, false) }.buttonStyle(.bordered)
                            }
                            .controlSize(.small)
                        }
                    }
                }
            }
            Section("Saved People") {
                ForEach(people) { p in
                    NavigationLink { PersonDetailView(person: p, allPeople: people) } label: {
                        HStack {
                            Text(p.displayName)
                            if p.isSelf { Text("You").font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2).background(.fill.secondary, in: Capsule()) }
                            Spacer()
                            if p.hasAccount { Image(systemName: "person.crop.circle.badge.checkmark").foregroundStyle(.secondary).accessibilityLabel("Has account") }
                        }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search saved people")
        .navigationTitle("People")
        .task(id: query) { await load() }
        .refreshable { await load() }
        .confirmationDialog("Already saved?", isPresented: Binding(get: { !duplicates.isEmpty }, set: { if !$0 { duplicates = [] } }), titleVisibility: .visible) {
            Button("Create a new \(newName) anyway") { create(confirm: true) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("You already have " + duplicates.map(\.displayName).formatted(.list(type: .and)) + ".") }
        .errorAlert($error)
    }

    private func load() async {
        people = (try? await model.api.people(query: query.isEmpty ? nil : query).people) ?? []
        links = (try? await model.api.linkRequests().requests) ?? []
    }

    private func create(confirm: Bool) {
        perform($busy, $error) {
            let r = try await model.api.createPerson(name: newName, confirmNew: confirm)
            if r.created { newName = ""; duplicates = []; await load() } else { duplicates = r.possibleDuplicates }
        }
    }

    private func respond(_ id: String, _ approve: Bool) {
        perform($busy, $error) { try await model.api.respondLink(id, approve: approve); await load() }
    }
}

struct PersonDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let person: Person
    let allPeople: [Person]
    @State private var stats: PersonAnalyticsResponse?
    @State private var name = ""
    @State private var showMerge = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if person.canEdit {
                Section("Name") {
                    TextField("Name", text: $name)
                    Button("Save Name") { perform($busy, $error) { _ = try await model.api.renamePerson(person.id, name: name); model.show("Saved") } }
                        .disabled(name == person.displayName || name.isEmpty)
                    if !person.hasAccount { Button("Merge Into Another Saved Person…") { showMerge = true } }
                }
            } else if !person.hasAccount {
                Section {
                    Button("This Is Me — Request Account Link") {
                        perform($busy, $error) { try await model.api.requestPersonLink(person.id); model.show("Request sent") }
                    }
                } footer: { Text("Whoever saved this person must approve.") }
            }
            if let a = stats?.analytics {
                Section {
                    LabeledContent("Nights played", value: "\(a.sessionsPlayed)")
                    LabeledContent("Rounds their crew hid", value: "\(a.roundsCrewHid)")
                    LabeledContent("Crew survival (avg)", value: a.crewHideSurvival.averageSeconds.map { (a.crewHideSurvival.includesCensored ? "≥" : "") + Fmt.clock(Double($0)) } ?? "—")
                    LabeledContent("Rounds their crew sought", value: "\(a.roundsCrewSought)")
                    LabeledContent("Crew time to find (avg)", value: a.crewSeekCapture.averageSeconds.map { Fmt.clock(Double($0)) } ?? "—")
                    LabeledContent("Paired nights", value: "\(a.pairedNights.stronger) stronger · \(a.pairedNights.weaker) weaker · \(a.pairedNights.provisional + a.pairedNights.insufficient) provisional")
                    if let op = a.operatorRounds { LabeledContent("Rounds as phone operator", value: "\(op)") }
                } header: { Text("Crew Stats (Team Level)") } footer: { Text(a.sampleNote) }
                if !a.compositions.isEmpty {
                    Section("Crew Compositions") {
                        ForEach(a.compositions) { c in
                            VStack(alignment: .leading) {
                                Text(c.members.map(\.displayName).joined(separator: ", ")).font(.callout)
                                Text("\(c.rounds) rounds · hid \(c.hideRounds)× · avg \(c.hideAverageSeconds.map { Fmt.clock(Double($0)) } ?? "—")").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !a.coPlayers.isEmpty {
                    Section("Played With") { ForEach(a.coPlayers) { c in LabeledContent(c.displayName, value: "\(c.sessionsTogether) nights") } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(person.displayName)
        .onAppear { name = person.displayName }
        .task { stats = try? await model.api.personAnalytics(person.id) }
        .confirmationDialog("Merge \(person.displayName) into…", isPresented: $showMerge, titleVisibility: .visible) {
            ForEach(allPeople.filter { $0.id != person.id && $0.canEdit }) { target in
                Button(target.displayName) {
                    perform($busy, $error) { try await model.api.mergePerson(person.id, into: target.id); dismiss() }
                }
            }
        } message: { Text("For duplicates of the same person.") }
        .errorAlert($error)
    }
}
