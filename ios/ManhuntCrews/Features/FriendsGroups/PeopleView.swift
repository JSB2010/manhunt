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
        .task(id: query) {
            // Debounce typing: a newer query cancels this task before it hits the network.
            if !query.isEmpty { try? await Task.sleep(nanoseconds: 300_000_000) }
            guard !Task.isCancelled else { return }
            await load()
        }
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
    @State private var statsError: String?
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
                // Headline numbers as tiles (ADR 0020); every one is the crew's, labelled so.
                Section {
                    StatGrid {
                        StatTile(label: "Nights", value: "\(a.sessionsPlayed)", detail: "\(a.roundsCrewHid + a.roundsCrewSought) rounds played", symbol: "moon.stars.fill")
                        StatTile(label: "Hiding", value: a.crewHideSurvival.averageSeconds.map { (a.crewHideSurvival.includesCensored ? "≥ " : "") + Fmt.clock(Double($0)) } ?? "—",
                                 detail: "Crew’s average over \(a.roundsCrewHid) \(a.roundsCrewHid == 1 ? "round" : "rounds")\(a.crewHideSurvival.censored > 0 ? ", \(a.crewHideSurvival.censored) never caught" : "")",
                                 symbol: Role.HIDING.symbol)
                        StatTile(label: "Seeking", value: a.crewSeekCapture.averageSeconds.map { Fmt.clock(Double($0)) } ?? "—",
                                 detail: "Crew’s average time to a catch, over \(a.roundsCrewSought) \(a.roundsCrewSought == 1 ? "round" : "rounds")",
                                 symbol: Role.SEEKING.symbol)
                        let compared = a.pairedNights.stronger + a.pairedNights.weaker + a.pairedNights.tied
                        let unfair = a.pairedNights.provisional + a.pairedNights.insufficient
                        StatTile(label: "Lasted longest", value: compared == 0 ? "—" : "\(a.pairedNights.stronger) of \(compared)",
                                 detail: "Fairly compared nights their crew lasted longest hiding\(unfair > 0 ? "; \(unfair) couldn’t be compared" : "")",
                                 symbol: "medal.fill")
                    }
                    .bareListRow()
                    if let op = a.operatorRounds { LabeledContent("Rounds carrying a phone", value: "\(op)") }
                } header: { Text("With Their Crews") } footer: { Text(a.sampleNote) }
                if !a.compositions.isEmpty {
                    Section("Crews They Played In") {
                        ForEach(a.compositions) { c in
                            VStack(alignment: .leading) {
                                Text(c.members.map(\.displayName).formatted(.list(type: .and))).font(.callout)
                                Text("\(c.rounds) \(c.rounds == 1 ? "round" : "rounds") · hid \(c.hideRounds)×\(c.hideAverageSeconds.map { " · lasted \(c.censoredHideRounds > 0 ? "≥ " : "")\(Fmt.clock(Double($0))) on average" } ?? "")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
                if !a.coPlayers.isEmpty {
                    Section("Played With") { ForEach(a.coPlayers) { c in LabeledContent(c.displayName, value: "\(c.sessionsTogether) nights") } }
                }
            } else if let statsError {
                // A failed load must not leave the spinner running forever.
                Section {
                    Label("Couldn’t load stats", systemImage: "exclamationmark.triangle")
                    Text(statsError).font(.footnote).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await loadStats() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(person.displayName)
        .onAppear { name = person.displayName }
        .task { await loadStats() }
        .refreshable { await loadStats() }
        .confirmationDialog("Merge \(person.displayName) into…", isPresented: $showMerge, titleVisibility: .visible) {
            ForEach(allPeople.filter { $0.id != person.id && $0.canEdit }) { target in
                Button(target.displayName) {
                    perform($busy, $error) { try await model.api.mergePerson(person.id, into: target.id); dismiss() }
                }
            }
        } message: { Text("For duplicates of the same person.") }
        .errorAlert($error)
    }

    private func loadStats() async {
        statsError = nil
        do { stats = try await model.api.personAnalytics(person.id) } catch {
            if !Task.isCancelled { statsError = error.localizedDescription }
        }
    }
}
