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

/// One crew in the lobby: identity, role, roster and readiness.
struct CrewRow: View {
    let team: TeamView
    let role: Role
    let ready: Bool
    var opponentHealth: OpponentHealthView?

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
                RoleLabel(role: role, crew: team.key)
                    .font(.subheadline.weight(.semibold))
            }
            if !team.roster.isEmpty {
                Text(team.roster.map(\.displayName).formatted(.list(type: .and)))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            FlowLayout(spacing: 6) {
                if team.hasOperator {
                    StatusBadge(text: team.operatorDisplayName ?? "Operator", systemImage: "iphone")
                    if team.consentGiven {
                        StatusBadge(text: "Disclosure accepted", systemImage: "checkmark.shield.fill", tint: Theme.ok)
                    } else {
                        StatusBadge(text: "Disclosure pending", systemImage: "hourglass", tint: Theme.warning)
                    }
                    if ready {
                        StatusBadge(text: "Ready", systemImage: "checkmark.circle.fill", tint: Theme.ok)
                    } else {
                        StatusBadge(text: "Not ready", systemImage: "circle")
                    }
                    if let h = opponentHealth, !team.isMine {
                        let p = HealthPresentation(health: h, inLobby: true)
                        StatusBadge(text: p.text, systemImage: p.symbol, tint: p.tint)
                    }
                } else {
                    StatusBadge(text: "Waiting for operator", systemImage: "hourglass", tint: Theme.warning)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Opponent integrity — coarse status only, never coordinates.
struct HealthPresentation {
    let text: String
    let symbol: String
    let state: StatusRow.State

    var tint: Color { StatusRow.tint(for: state) }
    /// Compact form for chips ("No signal").
    var shortText: String {
        switch text {
        case "No signal from phone": "no signal"
        case "Location permission off": "location off"
        case "Tracking stopped": "tracking stopped"
        case "Tracking stale": "tracking stale"
        default: text.lowercased()
        }
    }
    var isProblem: Bool { state == .warning || state == .problem }

    init(health: OpponentHealthView, inLobby: Bool = false) {
        let v: (String, String, StatusRow.State)
        // Before a round, "not tracking" is expected — don’t alarm anyone.
        if inLobby && ["STOPPED", "UNKNOWN", "STALE", "NO_SIGNAL"].contains(health.state) {
            v = ("Not tracking yet", "location", .neutral)
        } else {
            v = switch health.state {
            case "ACTIVE": ("Tracking OK", "dot.radiowaves.left.and.right", .ok)
            case "STALE": ("Tracking stale", "exclamationmark.triangle.fill", .warning)
            case "NO_SIGNAL": ("No signal from phone", "antenna.radiowaves.left.and.right.slash", .problem)
            case "STOPPED": ("Tracking stopped", "location.slash.fill", .problem)
            case "PERMISSION_ISSUE": ("Location permission off", "location.slash.fill", .problem)
            default: ("Status unknown", "questionmark.circle", .neutral)
            }
        }
        text = v.0
        symbol = v.1
        state = v.2
    }

    /// Extra coarse issues reported for the opponent phone.
    static func extraIssues(_ health: OpponentHealthView) -> [String] {
        var out: [String] = []
        if health.issues.contains("PRECISE_LOCATION_OFF") { out.append("Approximate location") }
        if health.issues.contains("LOW_POWER_MODE") { out.append("Low Power Mode") }
        return out
    }
}
