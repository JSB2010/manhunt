import SwiftUI

/// Routes the open night by *server* phase: lobby → game → recap → next round.
struct SessionContainerView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let v = model.sessionView {
                if v.session.revoked {
                    ContentUnavailableView {
                        Label("Night Revoked", systemImage: "lock.slash")
                    } description: {
                        Text("The organizer revoked this night. Access to routes and photos was removed.")
                    } actions: {
                        Button("Close") { model.closeSession() }.buttonStyle(.borderedProminent)
                    }
                } else if let round = v.round {
                    switch round.state {
                    case .READY:
                        LobbyView(view: v, round: round)
                    case .HEAD_START, .CHASE, .CAPTURE_PENDING, .PAUSED:
                        GameView(view: v, round: round)
                    case .COMPLETED, .TIMED_OUT, .ABORTED:
                        NavigationStack { RoundRecapView(sessionId: v.sessionId, roundId: round.id, live: v) }
                    }
                } else {
                    ProgressView()
                }
            } else if let err = model.viewError {
                ContentUnavailableView {
                    Label("Can’t Load This Night", systemImage: "exclamationmark.icloud")
                } description: {
                    Text(err)
                } actions: {
                    Button("Try Again") { Task { await model.reloadSessionView() } }
                        .buttonStyle(.borderedProminent)
                    Button("Close") { model.closeSession() }
                }
            } else {
                ProgressView("Connecting to the night…")
            }
        }
        .safeAreaInset(edge: .top) {
            if model.sessionView != nil && (model.viewFromCache || model.viewError != nil) {
                OfflineBanner(message: model.viewError ?? "Offline — showing the last known state. Nothing new is confirmed until you reconnect.")
                    .padding(.horizontal)
            }
        }
    }
}

/// Connection problem shown above any session screen (functional layer).
private struct OfflineBanner: View {
    let message: String
    var body: some View {
        Label {
            Text(message).foregroundStyle(.primary)
        } icon: {
            Image(systemName: "wifi.slash").foregroundStyle(Theme.warning)
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// One crew in the lobby: its colour and role, its people (a phone shows on its owner), readiness.
struct CrewRow: View {
    let team: TeamView
    let role: Role?
    let ready: Bool
    var status: CrewStatusView?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let role {
                    RoleLabel(role: role, crew: team.key).font(.headline)
                } else {
                    CrewDot(key: team.key)
                    Text(team.key.colourName).font(.headline)
                }
                if team.isMine {
                    Text("You")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(.fill.secondary, in: Capsule())
                }
                Spacer(minLength: 8)
                if role != nil && team.hasPhone {
                    if ready {
                        StatusBadge(text: "Ready", systemImage: "checkmark.circle.fill", tint: Theme.ok)
                    } else {
                        StatusBadge(text: "Not ready", systemImage: "circle")
                    }
                }
            }
            FlowLayout(spacing: 6) {
                ForEach(team.roster) { p in PersonBadge(person: p, phone: team.phone(of: p.personId)) }
                // A phone with no name linked (nights from before names followed phones).
                ForEach(team.operators.filter { op in op.personId.map { id in !team.roster.contains { $0.personId == id } } ?? true }, id: \.uid) { op in
                    StatusBadge(text: op.isMe ? "\(op.displayName) (you)" : op.displayName, systemImage: "iphone", tint: op.consentGiven ? .secondary : Theme.warning)
                }
            }
            if !team.hasPhone {
                StatusBadge(text: "No phone yet", systemImage: "hourglass", tint: Theme.warning)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// A person in the lobby: their name, with a phone if they carry one (warning tint until it has agreed to tracking).
struct PersonBadge: View {
    let person: PersonRef
    let phone: OperatorView?

    var body: some View {
        StatusBadge(text: phone?.isMe == true ? "\(person.displayName) (you)" : person.displayName,
                    systemImage: phone == nil ? "person.fill" : phone!.consentGiven ? "iphone" : "iphone.slash",
                    tint: phone.map { $0.consentGiven ? .secondary : Theme.warning } ?? .secondary)
            .accessibilityLabel(phone == nil ? person.displayName : "\(person.displayName), with a phone\(phone!.consentGiven ? "" : " that hasn’t agreed to tracking yet")")
    }
}

/// People sitting out this round, and their phones (which spectate).
struct SittingOutRow: View {
    let bench: SittingOutView

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Sitting Out", systemImage: "chair.lounge").font(.headline)
            FlowLayout(spacing: 6) {
                ForEach(bench.roster) { p in PersonBadge(person: p, phone: bench.operators.first { $0.personId == p.personId }) }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// A crew's phone status — coarse only ("2 of 2 live"), never times or coordinates.
struct HealthPresentation {
    let text: String
    let symbol: String
    let state: StatusRow.State

    var tint: Color { StatusRow.tint(for: state) }
    var isProblem: Bool { state == .warning || state == .problem }

    init(status: CrewStatusView) {
        let v: (String, String, StatusRow.State) = switch status.state {
        case "ACTIVE": (status.total > 1 ? "\(status.live) of \(status.total) live" : "Live", "dot.radiowaves.left.and.right", status.live < status.total ? .warning : .ok)
        case "STARTING": ("Starting", "hourglass", .neutral)
        case "STALE": ("Signal weak", "exclamationmark.triangle.fill", .warning)
        case "NO_SIGNAL": ("No signal", "antenna.radiowaves.left.and.right.slash", .problem)
        case "STOPPED": ("Tracking stopped", "location.slash.fill", .problem)
        case "PERMISSION_ISSUE": ("Location off", "location.slash.fill", .problem)
        default: ("Unknown", "questionmark.circle", .neutral)
        }
        text = v.0
        symbol = v.1
        state = v.2
    }

    /// Extra coarse issues reported for a crew's phones.
    static func extraIssues(_ status: CrewStatusView) -> [String] {
        var out: [String] = []
        if status.issues.contains("PRECISE_LOCATION_OFF") { out.append("Approximate location") }
        if status.issues.contains("LOW_POWER_MODE") { out.append("Low Power Mode") }
        return out
    }
}
