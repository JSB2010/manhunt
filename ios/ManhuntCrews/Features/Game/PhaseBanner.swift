import SwiftUI

/// Outdoors-readable phase + clock on a Liquid Glass panel, computed every second
/// from server timestamps (`ServerClock`). Never a free-running local timer.
struct PhaseBanner: View {
    let view: SessionViewDoc
    let round: RoundView
    var showPassengerReminder = true
    @ScaledMetric(relativeTo: .largeTitle) private var clockSize: CGFloat = 58

    private var crewColor: Color { view.session.myTeam.map(Theme.crew) ?? .secondary }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.shared.now()
            VStack(spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let role = round.myRole {
                        Image(systemName: phaseSymbol(role))
                            .foregroundStyle(phaseTint)
                            .accessibilityHidden(true)
                    }
                    Text(title)
                        .accessibilityIdentifier("game.phase")
                    Spacer(minLength: 8)
                    Text("Round \(round.index) of \(view.session.totalRounds)")
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline.weight(.semibold))

                Text(bigClock(now))
                    .font(.system(size: clockSize, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .contentTransition(.numericText(countsDown: round.effectiveState == .HEAD_START))
                    .accessibilityLabel(accessibilityClock(now))
                    .accessibilityAddTraits(.updatesFrequently)

                Text(subtitle(now))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if round.myRole == .SEEKING && showPassengerReminder {
                    Label("Passenger only — the driver never uses this app", systemImage: "car.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .glassSurface(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .accessibilityElement(children: .contain)
        }
    }

    private var phaseTint: Color {
        switch round.state {
        case .PAUSED: round.pause?.kind == "SAFETY" ? Theme.danger : Theme.warning
        default: crewColor
        }
    }

    private func phaseSymbol(_ role: Role) -> String {
        switch round.state {
        case .PAUSED: round.pause?.kind == "SAFETY" ? "exclamationmark.octagon.fill" : "pause.circle.fill"
        case .CAPTURE_PENDING: "camera.fill"
        default: role.symbol
        }
    }

    private var title: String {
        let role = round.myRole?.label ?? ""
        switch round.state {
        case .HEAD_START: return "Head Start · \(role)"
        case .CHASE: return "Chase · \(role)"
        case .CAPTURE_PENDING: return "Catch Pending · \(role)"
        case .PAUSED: return round.pause?.kind == "SAFETY" ? "Safety Pause" : "Paused"
        default: return round.state.label
        }
    }

    private func headStartRemaining(_ now: Date) -> Double {
        let elapsed = round.headStartClock.elapsedMs(at: now) / 1000
        return max(0, Double(round.rules.headStartSeconds) - elapsed)
    }

    private func chaseSeconds(_ now: Date) -> Double { (round.chaseClock?.elapsedMs(at: now) ?? 0) / 1000 }

    private func bigClock(_ now: Date) -> String {
        round.effectiveState == .HEAD_START ? Fmt.clock(headStartRemaining(now)) : Fmt.clock(chaseSeconds(now))
    }

    private func accessibilityClock(_ now: Date) -> String {
        round.effectiveState == .HEAD_START
            ? "Head start remaining: \(Fmt.spokenDuration(headStartRemaining(now)))"
            : "Chase time: \(Fmt.spokenDuration(chaseSeconds(now)))"
    }

    private func subtitle(_ now: Date) -> String {
        switch round.state {
        case .HEAD_START:
            return round.myRole == .HIDING ? "Move! The seekers get your first ping at 0:00." : "Wait here. The first ping releases at 0:00 — then go."
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
            return round.myRole == .SEEKING ? "Clock frozen at submission. Waiting for the hiders to confirm (\(exp))." : "Review the catch photo (\(exp) left)."
        case .PAUSED:
            return round.pause?.reason ?? "Clock and pings are frozen."
        default:
            return ""
        }
    }
}

/// Blocks the map while a round is paused; both operators must resume.
struct PausedOverlay: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView
    @State private var busy = false
    @State private var error: String?

    private var safety: Bool { round.pause?.kind == "SAFETY" }
    private var mine: Bool { view.session.myTeam.map { round.pause?.resumeVotes[$0.rawValue] == true } ?? false }

    var body: some View {
        ZStack {
            Color.black.opacity(0.35).ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: safety ? "exclamationmark.octagon.fill" : "pause.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(safety ? Theme.danger : Theme.warning)
                    .symbolRenderingMode(.hierarchical)
                    .accessibilityHidden(true)
                Text(safety ? "Safety Pause" : "Round Paused")
                    .font(.title.bold())
                    .accessibilityAddTraits(.isHeader)
                if let by = round.pause?.byTeam, let name = view.session.team(by)?.name {
                    Text("Paused by \(name)").font(.headline).foregroundStyle(.secondary)
                }
                if let reason = round.pause?.reason {
                    Text(reason).font(.title3).multilineTextAlignment(.center)
                }
                Text("The clock and ping schedule are frozen for both crews. Both operators must tap Resume.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                VStack(spacing: 8) {
                    ForEach(TeamKey.allCases) { k in
                        let ready = round.pause?.resumeVotes[k.rawValue] == true
                        HStack {
                            CrewDot(key: k)
                            Text(view.session.team(k)?.name ?? k.rawValue)
                            Spacer()
                            Label(ready ? "Ready" : "Waiting", systemImage: ready ? "checkmark.circle.fill" : "hourglass")
                                .foregroundStyle(ready ? Theme.ok : .secondary)
                        }
                        .font(.subheadline.weight(.medium))
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.vertical, 4)
                Button {
                    perform($busy, $error) { try await model.api.resume(view.sessionId, round.id) }
                } label: {
                    ActionLabel(title: mine ? "Waiting for the Other Crew" : "Ready to Resume", systemImage: "play.fill", busy: busy)
                }
                .floatingProminentButton()
                .controlSize(.large)
                .disabled(mine || busy)
            }
            .padding(24)
            .frame(maxWidth: 440)
            .glassSurface(in: RoundedRectangle(cornerRadius: 34, style: .continuous))
            .padding()
        }
        .accessibilityAddTraits(.isModal)
        .errorAlert($error)
    }
}
