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

/// One crew in the lobby: identity, role, roster, phones and readiness.
struct CrewRow: View {
    let team: TeamView
    let role: Role?
    let ready: Bool
    var status: CrewStatusView?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                CrewDot(key: team.key)
                Text(team.name).font(.headline)
                if team.isMine {
                    Text("You")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(.fill.secondary, in: Capsule())
                }
                Spacer(minLength: 8)
                if let role {
                    RoleLabel(role: role, crew: team.key)
                        .font(.subheadline.weight(.semibold))
                }
            }
            if !team.roster.isEmpty {
                Text(team.roster.map(\.displayName).formatted(.list(type: .and)))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            FlowLayout(spacing: 6) {
                if team.hasPhone {
                    ForEach(team.operators, id: \.uid) { op in
                        StatusBadge(text: op.isMe ? "\(op.displayName) (you)" : op.displayName,
                                    systemImage: op.consentGiven ? "iphone" : "iphone.slash",
                                    tint: op.consentGiven ? .secondary : Theme.warning)
                    }
                    if role != nil {
                        if ready {
                            StatusBadge(text: "Ready", systemImage: "checkmark.circle.fill", tint: Theme.ok)
                        } else {
                            StatusBadge(text: "Not ready", systemImage: "circle")
                        }
                    }
                } else {
                    StatusBadge(text: "No phone yet", systemImage: "hourglass", tint: Theme.warning)
                }
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
