import SwiftUI

struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [SessionListItem] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            ForEach(items) { s in
                NavigationLink { SessionDetailView(item: s) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(s.title).font(.headline)
                            Spacer()
                            Text(s.scheduledDate).font(.caption).foregroundStyle(.secondary)
                        }
                        Text("\(s.teams["A"]?.name ?? "A") vs \(s.teams["B"]?.name ?? "B") · \(s.completedRoundCount)/\(s.totalRounds) rounds")
                            .font(.callout)
                        Text(((s.teams["A"]?.roster ?? []) + (s.teams["B"]?.roster ?? [])).map(\.displayName).joined(separator: ", "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            if items.isEmpty && !loading {
                ContentUnavailableView("No nights yet", systemImage: "moon.stars", description: Text("Nights you host or join appear here."))
            }
        }
        .searchable(text: $query, prompt: "Crew, person, title or date")
        .navigationTitle("History")
        .task(id: query) {
            loading = true
            defer { loading = false }
            try? await Task.sleep(nanoseconds: 250_000_000)
            do { items = try await model.api.sessions(query: query).items } catch { self.error = error.localizedDescription }
        }
        .errorAlert($error)
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
                    Button { model.openSession(item.id) } label: { Label("Open night", systemImage: "play.circle.fill") }
                }
                NavigationLink { NightSummaryView(sessionId: item.id) } label: { Label("Scorecard & export", systemImage: "trophy") }
            }
            Section("Crews") {
                ForEach(TeamKey.allCases) { k in
                    if let t = item.teams[k.rawValue] {
                        VStack(alignment: .leading) {
                            HStack { Circle().fill(Color(hex: t.color)).frame(width: 10); Text(t.name).font(.headline) }
                            Text(t.roster.map(\.displayName).joined(separator: ", ")).font(.caption)
                            if let op = t.operatorDisplayName { Text("Operator: \(op)").font(.caption2).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            Section("Rounds") {
                ForEach(view?.previousRounds ?? []) { b in
                    NavigationLink { RoundRecapView(sessionId: item.id, roundId: b.roundId) } label: {
                        HStack {
                            Text("Round \(b.index)").bold()
                            Text("\(item.teams[b.hidingTeam.rawValue]?.name ?? "") hid").foregroundStyle(.secondary)
                            Spacer()
                            Text(b.outcome == "CAUGHT" ? Fmt.clock(Double(b.observedChaseSeconds)) : b.outcome == "TIMED_OUT" ? "≥ \(Fmt.clock(Double(b.observedChaseSeconds)))" : "aborted").monospacedDigit()
                        }
                    }
                }
                if (view?.previousRounds ?? []).isEmpty { Text("No finished rounds").foregroundStyle(.secondary) }
            }
            Section {
                Button("Delete my tracks & photos from this night", role: .destructive) { confirmMyData = true }
                if item.isHost { Button("Delete this night for everyone", role: .destructive) { confirmDelete = true } }
            } footer: {
                Text("Deleting your data removes your operator routes, raw GPS and photos you took; crew scores remain. The organizer can't override your deletion.")
            }
        }
        .navigationTitle(item.title)
        .task { view = try? await model.api.session(item.id) }
        .confirmationDialog("Delete your tracks and photos?", isPresented: $confirmMyData, titleVisibility: .visible) {
            Button("Delete my data", role: .destructive) {
                perform($busy, $error) {
                    let r = try await model.api.deleteMyData(item.id)
                    model.show("Deleted \(r.pointsDeleted) GPS points and \(r.photosDeleted) photos")
                }
            }
        }
        .confirmationDialog("Delete the whole night?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete night", role: .destructive) {
                perform($busy, $error) {
                    try await model.api.deleteSession(item.id)
                    dismiss()
                }
            }
        } message: { Text("Removes rounds, routes, photos and exports for both operators. This can't be undone.") }
        .errorAlert($error)
    }
}
