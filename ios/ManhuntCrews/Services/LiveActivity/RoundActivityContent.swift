import Foundation

/// Maps the phone's own sanitized view to its round Live Activity. It is the same mapping
/// as the server's `liveActivityState` (backend/src/domain/views.ts), so a local update and
/// an ActivityKit push for the same view carry identical content (ADR 0017). The input is
/// the view, so the Lock Screen can never show more than the game screen — and it shows less:
/// no pins, no rosters, no free-text reasons.
enum RoundActivityContent {
    typealias State = RoundActivityAttributes.ContentState

    static func attributes(for view: SessionViewDoc) -> RoundActivityAttributes? {
        guard let r = view.round, let role = r.myRole, let team = r.myTeam, r.state != .READY else { return nil }
        return RoundActivityAttributes(
            sessionId: view.sessionId,
            roundId: r.id,
            roundIndex: r.index,
            role: role == .HIDING ? .HIDING : .SEEKING,
            crew: team.rawValue,
            crewName: view.session.team(team)?.name ?? "Crew \(team.rawValue)")
    }

    /// Epoch milliseconds of a decoded server timestamp (the server sends whole milliseconds).
    static func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }

    /// `clockOffsetMs`: this phone's clock minus server time, so the system's timers read server time.
    static func state(for r: RoundView, clockOffsetMs: Double = 0) -> State? {
        guard r.myRole != nil, r.state != .READY, r.roundStartAt != nil else { return nil }
        func at(_ d: Date?) -> Double? { d.map { (ms($0) + clockOffsetMs) / 1000 } }
        let ended = r.state.isFinished
        let phase: RoundActivityAttributes.Phase = switch r.state {
        case .HEAD_START: .HEAD_START
        case .CHASE: .CHASE
        case .CAPTURE_PENDING: .CAPTURE_PENDING
        case .PAUSED: .PAUSED
        default: .ENDED
        }
        let chase = r.chaseClock
        let chaseRunning = !ended && chase?.runningSince != nil
        let chaseElapsed: Double? = ended
            ? r.result.map { Double($0.observedChaseSeconds) } ?? (chase.map { $0.accumulatedMs / 1000 } ?? 0)
            : (chase != nil && !chaseRunning ? chase!.accumulatedMs / 1000 : nil)
        let outcome: RoundActivityAttributes.Result? = ended
            ? .init(
                result: r.result.flatMap { RoundActivityAttributes.Outcome(rawValue: $0.outcome) } ?? (r.state == .COMPLETED ? .CAUGHT : r.state == .TIMED_OUT ? .TIMED_OUT : .ABORTED),
                creditCrews: r.result?.catchCreditTeams.map(\.rawValue) ?? [])
            : nil
        return State(
            phase: phase,
            pausedPhase: r.state == .PAUSED ? (r.pausedFromState == .HEAD_START ? .HEAD_START : .CHASE) : nil,
            safetyPause: r.state == .PAUSED && r.pause?.kind == "SAFETY",
            headStartEndsAt: r.state == .HEAD_START ? at(r.headStartEndsAt) : nil,
            headStartRemaining: r.state == .PAUSED && r.pausedFromState == .HEAD_START
                ? max(0, Double(r.rules.headStartSeconds) - r.headStartClock.accumulatedMs / 1000) : nil,
            chaseStartedAt: chaseRunning ? (ms(chase!.runningSince!) - chase!.accumulatedMs + clockOffsetMs) / 1000 : nil,
            chaseElapsed: chaseElapsed,
            nextPingAt: r.state == .CHASE ? at(r.nextPingAt) : nil,
            nextPingIndex: r.nextPingIndex,
            timeCapAt: r.state == .CHASE ? at(r.timeCapAt) : nil,
            lastPing: r.pingLog.last.map { .init(index: $0.index, at: at($0.releasedAt)!, missing: $0.status != "RELEASED") },
            pingWaiting: !ended && r.waitingPing != nil,
            claim: !ended ? r.claimByTeam.map { .init(crew: $0.rawValue, expiresAt: at(r.captureRequest?.expiresAt ?? r.myClaim?.expiresAt)) } : nil,
            outcome: outcome)
    }
}
