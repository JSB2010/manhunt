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
                NavigationLink { NightSummaryView(sessionId: s.id, item: s) } label: { NightRow(item: s) }
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
