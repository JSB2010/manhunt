import SwiftUI

/// Large outdoors-readable phase + clock, computed every second from server
/// timestamps (`ServerClock`). Never a free-running local timer.
struct PhaseBanner: View {
    let view: SessionViewDoc
    let round: RoundView

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.shared.now()
            VStack(spacing: 4) {
                HStack {
                    Text(title).font(.headline.weight(.heavy)).foregroundStyle(accent)
                    Spacer()
                    Text("Round \(round.index)/\(view.session.totalRounds)").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text(bigClock(now))
                    .font(.system(size: 58, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.5)
                    .contentTransition(.numericText())
                    .accessibilityLabel(accessibilityClock(now))
                Text(subtitle(now))
                    .font(.callout.weight(.semibold))
                    .multilineTextAlignment(.center)
            }
            .padding(14)
            .frame(maxWidth: .infinity)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(accent.opacity(0.6), lineWidth: 2))
        }
    }

    private var accent: Color { round.myRole == .HIDING ? Theme.hiding : Theme.seeking }

    private var title: String {
        let role = round.myRole.map { $0 == .HIDING ? "HIDING" : "SEEKING" } ?? ""
        switch round.state {
        case .HEAD_START: return "HEAD START · \(role)"
        case .CHASE: return "CHASE · \(role)"
        case .CAPTURE_PENDING: return "CATCH PENDING"
        case .PAUSED: return round.pause?.kind == "SAFETY" ? "SAFETY PAUSE" : "PAUSED"
        default: return round.state.label.uppercased()
        }
    }

    private func headStartRemaining(_ now: Date) -> Double {
        let elapsed = round.headStartClock.elapsedMs(at: now) / 1000
        return max(0, Double(round.rules.headStartSeconds) - elapsed)
    }

    private func bigClock(_ now: Date) -> String {
        switch round.effectiveState {
        case .HEAD_START: return Fmt.clock(headStartRemaining(now))
        default: return Fmt.clock(ms: round.chaseClock?.elapsedMs(at: now) ?? 0)
        }
    }

    private func accessibilityClock(_ now: Date) -> String {
        round.effectiveState == .HEAD_START ? "Head start remaining \(bigClock(now))" : "Chase time \(bigClock(now))"
    }

    private func subtitle(_ now: Date) -> String {
        switch round.state {
        case .HEAD_START:
            return round.myRole == .HIDING ? "Move! Seekers start and get your first ping at 0:00." : "Wait. First hiding-crew ping at 0:00 — then go."
        case .CHASE:
            var parts: [String] = []
            if let next = round.nextPingAt {
                let s = next.timeIntervalSince(now)
                parts.append(s > 0 ? "Next ping in \(Fmt.clock(s))" : "Ping releasing…")
            }
            if let cap = round.timeCapAt { parts.append("Limit in \(Fmt.clock(max(0, cap.timeIntervalSince(now))))") }
            return parts.joined(separator: " · ")
        case .CAPTURE_PENDING:
            let exp = (round.myClaim?.expiresAt ?? round.captureRequest?.expiresAt).map { Fmt.clock(max(0, $0.timeIntervalSince(now))) } ?? "—"
            return round.myRole == .SEEKING ? "Clock frozen at submission. Waiting for hiders to confirm (\(exp))." : "Review the catch photo (\(exp) left)."
        case .PAUSED:
            return round.pause?.reason ?? "Clock and pings are frozen."
        default:
            return ""
        }
    }
}

struct PausedOverlay: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: round.pause?.kind == "SAFETY" ? "exclamationmark.octagon.fill" : "pause.circle.fill")
                .font(.system(size: 64)).foregroundStyle(round.pause?.kind == "SAFETY" ? Theme.danger : .orange)
            Text(round.pause?.kind == "SAFETY" ? "SAFETY PAUSE" : "Round paused").font(.largeTitle.weight(.heavy))
            if let by = round.pause?.byTeam, let name = view.session.team(by)?.name { Text("Paused by \(name)") }
            if let reason = round.pause?.reason { Text(reason).font(.title3).multilineTextAlignment(.center) }
            Text("Clock and ping schedule are frozen for both crews. Both operators must tap Resume.").multilineTextAlignment(.center).foregroundStyle(.secondary)
            HStack {
                ForEach(TeamKey.allCases) { k in
                    StatusPill(text: "\(view.session.team(k)?.name ?? k.rawValue): \(round.pause?.resumeVotes[k.rawValue] == true ? "ready" : "waiting")",
                               color: round.pause?.resumeVotes[k.rawValue] == true ? Theme.ok : .secondary)
                }
            }
            let mine = view.session.myTeam.map { round.pause?.resumeVotes[$0.rawValue] == true } ?? false
            BigButton(title: mine ? "Waiting for other crew…" : "Ready to resume", systemImage: "play.fill", busy: busy) {
                perform($busy, $error) { try await model.api.resume(view.sessionId, round.id) }
            }
            .disabled(mine)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.ultraThickMaterial)
        .errorAlert($error)
    }
}
