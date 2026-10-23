import SwiftUI

/// Everyone in the night, by crew, plus Sitting Out (ADR 0019): drag people between crews, or use a
/// person's menu. People with a phone carry it with them; nobody's phone is placed on its own.
struct PeopleBoard: View {
    @Environment(AppModel.self) private var model
    @Binding var board: CrewBoard
    /// Phones in the night by their owner's person id (empty while creating a night).
    var phones: [String: OperatorView] = [:]
    /// People who can't sit out (the creator of a new night: their phone plays).
    var mustPlay: Set<String> = []
    /// People who can't be removed from the night (this phone's owner).
    var cannotLeave: Set<String> = []
    /// Phones that will be taken out of the night on save (their owners keep playing).
    @Binding var phonesOut: Set<String>
    var groupPeople: [Person] = []

    init(board: Binding<CrewBoard>, phones: [String: OperatorView] = [:], mustPlay: Set<String> = [], cannotLeave: Set<String> = [], phonesOut: Binding<Set<String>> = .constant([]), groupPeople: [Person] = []) {
        _board = board
        self.phones = phones
        self.mustPlay = mustPlay
        self.cannotLeave = cannotLeave
        _phonesOut = phonesOut
        self.groupPeople = groupPeople
    }

    var body: some View {
        Section {
            Picker("Crews", selection: Binding(get: { board.crews.count }, set: { board.setCrewCount($0) })) {
                Text("2 Crews").tag(2)
                Text("3 Crews").tag(3)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("crews.count")
            Button { board.shuffle { $0.personId.map { phones[$0] != nil || mustPlay.contains($0) } ?? false } } label: {
                Label("Shuffle Crews", systemImage: "shuffle")
            }
            .disabled(board.crews.flatMap(\.roster).count < board.crews.count)
            .accessibilityIdentifier("crews.shuffle")
        } header: {
            Text("Crews")
        } footer: {
            Text("Drag people between crews, or tap ••• next to someone. A phone goes with its owner.")
        }
        ForEach(board.crews) { crew in
            Section {
                rows(.crew(crew.key))
            } header: {
                HStack(spacing: 6) {
                    CrewDot(key: crew.key)
                    Text(crew.key.colourName)
                    Spacer()
                    Text(count(crew.roster))
                }
            }
        }
        Section {
            rows(.bench)
        } header: {
            Label("Sitting Out", systemImage: "chair.lounge")
        } footer: {
            Text("Still in the night, not playing: someone taking a break, or not here yet. Their phones stay connected but aren’t tracked.")
        }
    }

    @ViewBuilder private func rows(_ place: CrewBoard.Place) -> some View {
        let people = board.people(in: place)
        ForEach(people, id: \.self) { e in
            row(e, place)
                .draggable(CrewBoard.id(e))
                .dropDestination(for: String.self) { ids, _ in drop(ids, to: place, before: CrewBoard.id(e)) }
        }
        AddPeopleRow(inPlace: Set(people.map(CrewBoard.id)), groupPeople: groupPeople) { board.add($0, to: place) }
            .dropDestination(for: String.self) { ids, _ in drop(ids, to: place, before: nil) }
    }

    private func row(_ e: RosterEntryBody, _ place: CrewBoard.Place) -> some View {
        let id = CrewBoard.id(e)
        let phone = e.personId.flatMap { phones[$0] }
        let isMe = e.personId != nil && e.personId == model.me?.profile.selfPersonId || phone?.isMe == true
        // While creating a night, the creator's own phone plays: show it on their row.
        let carriesPhone = phone != nil || mustPlay.contains(id)
        return HStack(spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: !carriesPhone ? "person.fill" : phone.map { phonesOut.contains($0.uid) } == true ? "iphone.slash" : "iphone")
                    .foregroundStyle(phone.map { phonesOut.contains($0.uid) || !$0.consentGiven ? Theme.warning : .secondary } ?? .secondary)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(isMe ? "\(e.displayName) (you)" : e.displayName)
                    if let phone, phonesOut.contains(phone.uid) {
                        Text("Phone leaves the night on save").font(.caption).foregroundStyle(Theme.warning)
                    } else if let phone, phone.displayName != e.displayName {
                        Text("\(phone.displayName)’s phone").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityLabel(e, phone: phone, isMe: isMe))
            Spacer(minLength: 8)
            Menu { actions(id, phone: phone, from: place) } label: {
                Label("Move \(e.displayName)", systemImage: "ellipsis.circle").labelStyle(.iconOnly).font(.title3)
            }
            .accessibilityIdentifier("board.person.\(e.displayName)")
        }
        .contentShape(Rectangle())
        .contextMenu { actions(id, phone: phone, from: place) }
    }

    @ViewBuilder private func actions(_ id: String, phone: OperatorView?, from place: CrewBoard.Place) -> some View {
        ForEach(board.keys.filter { place != .crew($0) }) { k in
            Button { withAnimation { board.move(id, to: .crew(k)) } } label: {
                Text("Move to \(k.colourName)")
                Text(board.label(k))
            }
        }
        if place != .bench && !mustPlay.contains(id) {
            Button { withAnimation { board.move(id, to: .bench) } } label: { Label("Sit Out", systemImage: "chair.lounge") }
        }
        if let phone, !phone.isMe {
            if phonesOut.contains(phone.uid) {
                Button { phonesOut.remove(phone.uid) } label: { Label("Keep Their Phone", systemImage: "iphone") }
            } else {
                Button { phonesOut.insert(phone.uid) } label: { Label("Take Their Phone Out", systemImage: "iphone.slash") }
            }
        }
        if !cannotLeave.contains(id) && !mustPlay.contains(id) {
            Divider()
            Button(role: .destructive) { withAnimation { board.remove(id) } } label: {
                Label(phone == nil ? "Remove From Night" : "Remove (Their Phone Leaves Too)", systemImage: "person.badge.minus")
            }
        }
    }

    private func drop(_ ids: [String], to place: CrewBoard.Place, before: String?) -> Bool {
        let known = ids.filter { board.place(of: $0) != nil && !(place == .bench && mustPlay.contains($0)) }
        guard !known.isEmpty else { return false }
        withAnimation { for id in known { board.move(id, to: place, before: before) } }
        return true
    }

    private func count(_ roster: [RosterEntryBody]) -> String {
        let n = roster.count
        let p = roster.compactMap(\.personId).filter { phones[$0] != nil }.count
        let people = n == 1 ? "1 person" : "\(n) people"
        return p == 0 ? people : "\(people) · \(p == 1 ? "1 phone" : "\(p) phones")"
    }

    private func accessibilityLabel(_ e: RosterEntryBody, phone: OperatorView?, isMe: Bool) -> String {
        var s = isMe ? "\(e.displayName), you" : e.displayName
        if let phone { s += phonesOut.contains(phone.uid) ? ", phone leaves on save" : ", has a phone" }
        return s
    }
}
