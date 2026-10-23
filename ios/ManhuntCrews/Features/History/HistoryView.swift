import SwiftUI

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [SessionListItem] = []
    @State private var query = ""
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            ForEach(items) { s in
                NavigationLink { SessionDetailView(item: s) } label: { NightRow(item: s) }
            }
        }
        .overlay {
            if loaded && items.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView("No Nights Yet", systemImage: "moon.stars", description: Text("Nights you host or join appear here, with scorecards for every round."))
                } else {
                    ContentUnavailableView.search(text: query)
                }
            } else if !loaded {
                ProgressView()
            }
        }
        .searchable(text: $query, prompt: "Crew, person, title or date")
        .navigationTitle("History")
        .task(id: query) {
            // Debounce typing; a newer query cancels this task, which is not an error.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            loading = true
            defer { loading = false; loaded = true }
            do {
                items = try await model.api.sessions(query: query).items
            } catch {
                if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
        .refreshable {
            do { items = try await model.api.sessions(query: query).items } catch { self.error = error.localizedDescription }
        }
        .errorAlert($error)
    }
}

private struct NightRow: View {
    let item: SessionListItem
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // Title and date side by side; stacked at accessibility text sizes.
        let header = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
        VStack(alignment: .leading, spacing: 6) {
            header {
                Text(item.title).font(.headline)
                Spacer(minLength: 0)
                Text(Fmt.day(item.scheduledDate)).font(.subheadline).foregroundStyle(.secondary)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { crews }
                VStack(alignment: .leading, spacing: 4) { crews }
            }
            .font(.subheadline)
            Text("\(item.completedRoundCount) \(item.completedRoundCount == 1 ? "round" : "rounds")\(item.status == .COMPLETED ? "" : " · in progress")")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var crews: some View {
        ForEach(TeamKey.allCases) { k in
            if let t = item.teams[k.rawValue] {
                HStack(spacing: 6) {
                    CrewDot(key: k)
                    Text(t.name)
                }
            }
        }
    }
}

struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let item: SessionListItem
    @State private var view: SessionViewDoc?
    @State private var confirmDelete = false
    @State private var confirmMyData = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                if item.status != .COMPLETED {
                    Button { model.openSession(item.id) } label: { Label("Open Night", systemImage: "play.circle.fill") }
                }
                NavigationLink { NightSummaryView(sessionId: item.id) } label: { Label("Scorecard & Export", systemImage: "trophy.fill") }
            }
            // Crews change during a night (ADR 0019): each round below names the people who played it.
            Section(item.status == .COMPLETED ? "Crews at the End" : "Crews Now") {
                ForEach(TeamKey.allCases) { k in
                    if let t = item.teams[k.rawValue] {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                CrewDot(key: k)
                                Text(t.name).font(.headline)
                            }
                            if !t.roster.isEmpty && !CrewNames.nameListsEveryone(t.name, people: t.roster, key: k) {
                                Text(t.roster.map(\.displayName).formatted(.list(type: .and)))
                                    .font(.subheadline)
                            }
                            if t.phoneCount > 0 {
                                Label(t.phoneCount == 1 ? "1 phone" : "\(t.phoneCount) phones", systemImage: "iphone")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            Section("Rounds") {
                ForEach(view?.previousRounds ?? []) { b in
                    NavigationLink { RoundRecapView(sessionId: item.id, roundId: b.roundId) } label: {
                        LabeledContent {
                            Text(Fmt.outcome(b.outcome, seconds: b.observedChaseSeconds)).monospacedDigit()
                        } label: {
                            Text("Round \(b.index)")
                            Text("\(b.name(b.hidingTeam) { item.teams[$0.rawValue]?.name }) hid")
                        }
                    }
                }
                if view != nil && (view?.previousRounds ?? []).isEmpty {
                    Text("No finished rounds").foregroundStyle(.secondary)
                }
            }
            Section {
                Button("Delete My Tracks & Photos From This Night", role: .destructive) { confirmMyData = true }
            } footer: {
                Text("Removes this phone’s routes, raw GPS and photos. Crew scores stay.")
            }
            if item.isHost {
                Section {
                    Button("Delete This Night for Everyone", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Removes every round, route and photo of this night for every phone.")
                }
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { view = try? await model.api.session(item.id) }
        .confirmationDialog("Delete your tracks and photos?", isPresented: $confirmMyData, titleVisibility: .visible) {
            Button("Delete My Data", role: .destructive) {
                perform($busy, $error) {
                    let r = try await model.api.deleteMyData(item.id)
                    model.show("Deleted \(r.pointsDeleted) GPS points and \(r.photosDeleted) photos")
                }
            }
        } message: { Text("This can’t be undone.") }
        .confirmationDialog("Delete the whole night?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Night", role: .destructive) {
                perform($busy, $error) {
                    try await model.api.deleteSession(item.id)
                    dismiss()
                }
            }
        } message: { Text("Removes rounds, routes and photos for everyone. This can’t be undone.") }
        .errorAlert($error)
    }
}
