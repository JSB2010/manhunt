import SwiftUI

/// Routes the open night by *server* phase: lobby → game → recap → next round.
struct SessionContainerView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let v = model.sessionView {
                if v.session.revoked {
                    ContentUnavailableView("Night revoked", systemImage: "lock.slash", description: Text("The organizer revoked this night. Access to routes and photos was removed."))
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
                VStack(spacing: 12) {
                    ContentUnavailableView("Can't load this night", systemImage: "exclamationmark.icloud", description: Text(err))
                    Button("Retry") { Task { await model.reloadSessionView() } }
                    Button("Close") { model.closeSession() }
                }
            } else {
                ProgressView("Connecting to the night…")
            }
        }
        .safeAreaInset(edge: .top) {
            if model.sessionView != nil && (model.viewFromCache || model.viewError != nil) {
                ErrorBanner(message: model.viewError ?? "Offline — showing last known state. Nothing new (pings, catches, uploads) is confirmed until reconnected.")
                    .padding(.horizontal)
            }
        }
    }
}

struct CrewTile: View {
    let team: TeamView
    let role: Role?
    let ready: Bool?
    var opponentHealth: OpponentHealthView?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(Color(hex: team.color)).frame(width: 14, height: 14)
                Text(team.name).font(.title3.weight(.bold))
                if team.isMine { StatusPill(text: "You", color: .accentColor) }
                Spacer()
                if let role { StatusPill(text: role.label.uppercased(), color: role == .HIDING ? Theme.hiding : Theme.seeking) }
            }
            if !team.roster.isEmpty {
                Text(team.roster.map(\.displayName).joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if team.hasOperator {
                    StatusPill(text: "📱 \(team.operatorDisplayName ?? "Operator")", color: .primary)
                } else {
                    StatusPill(text: "Waiting for operator", color: .orange, systemImage: "hourglass")
                }
                if team.hasOperator {
                    StatusPill(text: team.consentGiven ? "Disclosure ✓" : "Disclosure pending", color: team.consentGiven ? Theme.ok : .orange)
                }
                if let ready { StatusPill(text: ready ? "Ready" : "Not ready", color: ready ? Theme.ok : .secondary, systemImage: ready ? "checkmark.circle.fill" : "circle") }
            }
            if let h = opponentHealth, team.hasOperator, !team.isMine {
                HealthIntegrityPill(health: h)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: team.color).opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.corner))
        .overlay(RoundedRectangle(cornerRadius: Theme.corner).stroke(Color(hex: team.color).opacity(team.isMine ? 0.8 : 0.25), lineWidth: team.isMine ? 2 : 1))
        .accessibilityElement(children: .combine)
    }
}

/// Opponent integrity indicator — coarse status only, never coordinates.
struct HealthIntegrityPill: View {
    let health: OpponentHealthView
    var body: some View {
        let (text, color, icon): (String, Color, String) = switch health.state {
        case "ACTIVE": ("Tracking OK", Theme.ok, "dot.radiowaves.left.and.right")
        case "STALE": ("Tracking stale", .orange, "exclamationmark.triangle")
        case "NO_SIGNAL": ("No signal from phone", Theme.danger, "antenna.radiowaves.left.and.right.slash")
        case "STOPPED": ("Tracking stopped", Theme.danger, "location.slash")
        case "PERMISSION_ISSUE": ("Location permission off", Theme.danger, "location.slash")
        default: ("Status unknown", .secondary, "questionmark.circle")
        }
        HStack(spacing: 6) {
            StatusPill(text: text, color: color, systemImage: icon)
            if health.issues.contains("PRECISE_LOCATION_OFF") { StatusPill(text: "Approximate location", color: .orange) }
            if health.issues.contains("LOW_POWER_MODE") { StatusPill(text: "Low Power", color: .orange) }
        }
    }
}
