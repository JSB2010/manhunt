import { chaseStartDeadline, effectiveChaseMs, effectiveHeadStartMs, hasOpenPause, pingDeadline, runningSince, timeCapDeadline } from './clock.js';
import {
  isFinishedState,
  otherTeam,
  type CaptureClaim,
  type DeviceHealth,
  type MemberDoc,
  type PersonRef,
  type PingRelease,
  type Role,
  type RoundDoc,
  type RoundResult,
  type Rules,
  type SessionDoc,
  type TeamKey,
} from './types.js';

/**
 * Per-user sanitized read model (`sessions/{sid}/views/{uid}`).
 *
 * PRIVACY INVARIANT (spec §1, §5.1, §10.2): this renderer is the only code
 * that produces client-subscribable game state. Its inputs contain no raw GPS
 * samples, and the only coordinates it ever emits are *released* ping records.
 * While a round is active, the seeker receives released pins only; the hider's
 * live track, latest sample or unreleased positions never appear under any key.
 */

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export interface PinView {
  index: number;
  scheduledAt: string;
  releasedAt: string;
  observedAt: string | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  ageSeconds: number | null;
  delayed: boolean;
}

export interface PingLogEntry {
  index: number;
  scheduledAt: string;
  releasedAt: string;
  status: PingRelease['status'];
  ageSeconds: number | null;
  accuracyMeters: number | null;
  delayed: boolean;
}

export type OpponentTrackingState = 'ACTIVE' | 'STALE' | 'NO_SIGNAL' | 'STOPPED' | 'PERMISSION_ISSUE' | 'UNKNOWN';

export interface HealthView {
  lastHeartbeatAt: string | null;
  lastSampleRecordedAt: string | null;
  lastSampleAccuracyMeters: number | null;
  permission: DeviceHealth['permission'];
  preciseLocation: boolean;
  trackingActive: boolean;
  backgroundSessionActive: boolean;
  lowPowerMode: boolean;
  batteryLevel: number | null;
  networkReachable: boolean;
  queuedSamples: number;
}

export interface OpponentHealthView {
  state: OpponentTrackingState;
  /** coarsened to 30 s so upload timing cannot be used as a movement side channel */
  lastHeartbeatAt: string | null;
  issues: string[];
}

export interface RulesView extends Rules {}

export interface TeamView {
  teamId: string;
  key: TeamKey;
  name: string;
  color: string;
  roster: PersonRef[];
  operatorDisplayName: string | null;
  hasOperator: boolean;
  isMine: boolean;
  consentGiven: boolean;
}

export interface ClockView {
  accumulatedMs: number;
  runningSince: string | null;
}

export interface RoundView {
  id: string;
  index: number;
  state: RoundDoc['state'];
  pausedFromState: RoundDoc['pausedFromState'];
  myRole: Role | null;
  hidingTeam: TeamKey;
  seekingTeam: TeamKey;
  rules: RulesView;
  ready: Record<TeamKey, boolean>;
  roleOverride: { reason: string | null; suggestedHidingTeam: TeamKey } | null;
  roundStartAt: string | null;
  headStartEndsAt: string | null;
  chaseStartAt: string | null;
  headStartClock: ClockView;
  chaseClock: ClockView | null;
  nextPingAt: string | null;
  nextPingIndex: number;
  timeCapAt: string | null;
  pins: PinView[];
  pingLog: PingLogEntry[];
  pause: { kind: string; reason: string | null; startedAt: string; byTeam: TeamKey | null; resumeVotes: Record<TeamKey, boolean> } | null;
  pendingPauseRequest: { byTeam: TeamKey; at: string; expiresAt: string; reason: string | null; mine: boolean } | null;
  myClaim: { claimId: string; status: CaptureClaim['status']; submittedAt: string | null; expiresAt: string | null } | null;
  captureRequest: { claimId: string; submittedAt: string; expiresAt: string | null; chaseSecondsAtClaim: number | null; photoPath: string } | null;
  lastClaimOutcome: { status: string; at: string; reason: string | null } | null;
  myHealth: HealthView | null;
  opponentHealth: OpponentHealthView;
  result: RoundResult | null;
  endedAt: string | null;
  phaseGeneration: number;
}

export interface ViewDoc {
  schemaVersion: 1;
  uid: string;
  sessionId: string;
  renderedAt: string;
  stateVersion: number;
  session: {
    title: string;
    scheduledDate: string;
    status: SessionDoc['status'];
    isHost: boolean;
    myTeam: TeamKey | null;
    totalRounds: number;
    completedRoundCount: number;
    rules: RulesView;
    teams: Record<TeamKey, TeamView>;
    revoked: boolean;
  };
  round: RoundView | null;
  previousRounds: SessionDoc['roundBriefs'];
  nextRound: { index: number; suggestedHidingTeam: TeamKey } | null;
}

export const STALE_HEARTBEAT_MS = 90_000;
export const NO_SIGNAL_HEARTBEAT_MS = 300_000;

function healthView(h: DeviceHealth): HealthView {
  return {
    lastHeartbeatAt: iso(h.lastHeartbeatAt),
    lastSampleRecordedAt: iso(h.lastSampleRecordedAt),
    lastSampleAccuracyMeters: h.lastSampleAccuracyMeters,
    permission: h.permission,
    preciseLocation: h.preciseLocation,
    trackingActive: h.trackingActive,
    backgroundSessionActive: h.backgroundSessionActive,
    lowPowerMode: h.lowPowerMode,
    batteryLevel: h.batteryLevel,
    networkReachable: h.networkReachable,
    queuedSamples: h.queuedSamples,
  };
}

export function opponentHealth(h: DeviceHealth | undefined, now: number): OpponentHealthView {
  if (!h) return { state: 'UNKNOWN', lastHeartbeatAt: null, issues: [] };
  const issues: string[] = [];
  if (!h.preciseLocation) issues.push('PRECISE_LOCATION_OFF');
  if (h.lowPowerMode) issues.push('LOW_POWER_MODE');
  let state: OpponentTrackingState;
  if (h.permission === 'DENIED' || h.permission === 'RESTRICTED') state = 'PERMISSION_ISSUE';
  else if (!h.trackingActive && h.lastHeartbeatAt !== null) state = 'STOPPED';
  else if (h.lastHeartbeatAt === null) state = 'UNKNOWN';
  else if (now - h.lastHeartbeatAt > NO_SIGNAL_HEARTBEAT_MS) state = 'NO_SIGNAL';
  else if (now - h.lastHeartbeatAt > STALE_HEARTBEAT_MS) state = 'STALE';
  else state = 'ACTIVE';
  const coarse = h.lastHeartbeatAt === null ? null : Math.floor(h.lastHeartbeatAt / 30_000) * 30_000;
  return { state, lastHeartbeatAt: iso(coarse), issues };
}

function pinView(p: PingRelease): PinView | null {
  if (p.status !== 'RELEASED' || p.latitude === null || p.longitude === null) return null;
  return {
    index: p.index,
    scheduledAt: iso(p.scheduledAt)!,
    releasedAt: iso(p.releasedAt)!,
    observedAt: iso(p.observedAt),
    latitude: p.latitude,
    longitude: p.longitude,
    accuracyMeters: p.accuracyMeters,
    ageSeconds: p.ageSeconds,
    delayed: p.delayed,
  };
}

/** Released-pin layer with the history count applied (null = all). */
export function visiblePins(pings: readonly PingRelease[], historyCount: number | null): PinView[] {
  const released = pings.map(pinView).filter((p): p is PinView => p !== null).sort((a, b) => a.index - b.index);
  return historyCount === null ? released : released.slice(-historyCount);
}

function clockView(pauses: RoundDoc['pauses'], phaseStart: number | null, accumulatedMs: number, now: number, ended: boolean): ClockView {
  if (phaseStart === null || ended) return { accumulatedMs, runningSince: null };
  const since = runningSince(pauses, phaseStart, now);
  if (since === null) return { accumulatedMs, runningSince: null };
  // accumulated measured at `since`, so clients compute accumulated + (serverNow - since)
  const accAtSince = accumulatedMs - (now - since);
  return { accumulatedMs: Math.max(0, accAtSince), runningSince: iso(since) };
}

export function renderRound(params: {
  uid: string;
  session: SessionDoc;
  round: RoundDoc;
  members: Record<string, MemberDoc>;
  activeClaim: CaptureClaim | null;
  now: number;
}): RoundView {
  const { uid, session, round: r, members, activeClaim, now } = params;
  const myTeam: TeamKey | null = session.teams.A.operatorUid === uid ? 'A' : session.teams.B.operatorUid === uid ? 'B' : null;
  const finished = isFinishedState(r.state);
  const started = r.roundStartAt !== null;
  // Role is decided by team assignment (stable across rounds), never by a client payload.
  const myRole: Role | null = myTeam === null ? null : myTeam === r.hidingTeam ? 'HIDING' : 'SEEKING';
  const opponentTeam = myTeam ? otherTeam(myTeam) : null;
  const opponentUid = opponentTeam ? session.teams[opponentTeam].operatorUid : null;

  const headStartPauses = r.pauses.filter((p) => p.phase === 'HEAD_START');
  const chasePauses = r.pauses.filter((p) => p.phase === 'CHASE');
  const capturePendingOrPaused = r.state === 'CAPTURE_PENDING' || r.state === 'PAUSED';

  const headStartAcc = effectiveHeadStartMs(r, now);
  const headStartClock: ClockView =
    r.state === 'HEAD_START' && started
      ? clockView(headStartPauses, r.roundStartAt, headStartAcc, now, false)
      : r.state === 'PAUSED' && r.pausedFromState === 'HEAD_START'
        ? { accumulatedMs: headStartAcc, runningSince: null }
        : { accumulatedMs: headStartAcc, runningSince: null };

  let chaseClock: ClockView | null = null;
  if (r.chaseStartAt !== null) {
    if (finished && r.result) {
      chaseClock = { accumulatedMs: r.result.observedChaseSeconds * 1000, runningSince: null };
    } else {
      const acc = effectiveChaseMs(r, now);
      chaseClock = capturePendingOrPaused ? { accumulatedMs: acc, runningSince: null } : clockView(chasePauses, r.chaseStartAt, acc, now, false);
    }
  }

  const active = !finished && started;
  const nextPingAt = active && r.state === 'CHASE' && !hasOpenPause(r.pauses) ? pingDeadline(r, r.nextPingIndex) : r.state === 'HEAD_START' && !hasOpenPause(r.pauses) ? chaseStartDeadline(r) : null;
  const headStartEndsAt = r.state === 'HEAD_START' && !hasOpenPause(r.pauses) ? chaseStartDeadline(r) : null;

  // Released pins: visible to the seeking operator (and to the hider, whose own released
  // positions they are). After the round, the full released history is shown to both.
  const pins = myRole === null && !finished ? [] : visiblePins(r.pings, finished ? null : r.rules.visiblePingHistoryCount);
  const pingLog: PingLogEntry[] = r.pings.map((p) => ({
    index: p.index,
    scheduledAt: iso(p.scheduledAt)!,
    releasedAt: iso(p.releasedAt)!,
    status: p.status,
    ageSeconds: p.ageSeconds,
    accuracyMeters: p.accuracyMeters,
    delayed: p.delayed,
  }));

  const openNonCapturePause = r.pauses.find((p) => p.endAt === null && p.kind !== 'CAPTURE');
  const teamOf = (u: string | null): TeamKey | null => (u === null ? null : session.teams.A.operatorUid === u ? 'A' : session.teams.B.operatorUid === u ? 'B' : null);

  let myClaim: RoundView['myClaim'] = null;
  let captureRequest: RoundView['captureRequest'] = null;
  if (activeClaim && activeClaim.roundId === r.id) {
    if (myRole === 'SEEKING' && activeClaim.seekerUid === uid) {
      myClaim = { claimId: activeClaim.claimId, status: activeClaim.status, submittedAt: iso(activeClaim.submittedAt), expiresAt: iso(r.claimExpiresAt) };
    }
    if (myRole === 'HIDING' && uid === r.hiderUid && activeClaim.status === 'PENDING' && activeClaim.submittedAt !== null) {
      captureRequest = {
        claimId: activeClaim.claimId,
        submittedAt: iso(activeClaim.submittedAt)!,
        expiresAt: iso(r.claimExpiresAt),
        chaseSecondsAtClaim: activeClaim.officialChaseMsAtClaim === null ? null : Math.round(activeClaim.officialChaseMsAtClaim / 1000),
        photoPath: `/v1/sessions/${r.sessionId}/rounds/${r.id}/captures/${activeClaim.claimId}/photo`,
      };
    }
  }

  return {
    id: r.id,
    index: r.index,
    state: r.state,
    pausedFromState: r.pausedFromState,
    myRole,
    hidingTeam: r.hidingTeam,
    seekingTeam: r.seekingTeam,
    rules: { ...r.rules },
    ready: { A: !!r.ready.A, B: !!r.ready.B },
    roleOverride: r.roleOverride ? { reason: r.roleOverride.reason, suggestedHidingTeam: r.roleOverride.suggestedHidingTeam } : null,
    roundStartAt: iso(r.roundStartAt),
    headStartEndsAt: iso(headStartEndsAt),
    chaseStartAt: iso(r.chaseStartAt),
    headStartClock,
    chaseClock,
    nextPingAt: iso(nextPingAt),
    nextPingIndex: r.nextPingIndex,
    timeCapAt: iso(active ? timeCapDeadline(r) : null),
    pins,
    pingLog,
    pause:
      r.state === 'PAUSED' && openNonCapturePause
        ? {
            kind: openNonCapturePause.kind,
            reason: openNonCapturePause.reason,
            startedAt: iso(openNonCapturePause.startAt)!,
            byTeam: teamOf(openNonCapturePause.requestedByUid),
            resumeVotes: { A: !!r.resumeVotes.A, B: !!r.resumeVotes.B },
          }
        : null,
    pendingPauseRequest:
      r.pendingPauseRequest && r.pendingPauseRequest.expiresAt > now
        ? {
            byTeam: r.pendingPauseRequest.byTeam,
            at: iso(r.pendingPauseRequest.at)!,
            expiresAt: iso(r.pendingPauseRequest.expiresAt)!,
            reason: r.pendingPauseRequest.reason,
            mine: r.pendingPauseRequest.byUid === uid,
          }
        : null,
    myClaim,
    captureRequest,
    lastClaimOutcome: r.lastClaimOutcome ? { status: r.lastClaimOutcome.status, at: iso(r.lastClaimOutcome.at)!, reason: r.lastClaimOutcome.reason } : null,
    myHealth: members[uid] ? healthView(members[uid].health) : null,
    opponentHealth: opponentHealth(opponentUid ? members[opponentUid]?.health : undefined, now),
    result: finished ? r.result : null,
    endedAt: iso(r.endedAt),
    phaseGeneration: r.phaseGeneration,
  };
}

export function renderView(params: {
  uid: string;
  session: SessionDoc;
  round: RoundDoc | null;
  members: Record<string, MemberDoc>;
  activeClaim: CaptureClaim | null;
  now: number;
}): ViewDoc {
  const { uid, session, round, members, now } = params;
  const myTeam: TeamKey | null = session.teams.A.operatorUid === uid ? 'A' : session.teams.B.operatorUid === uid ? 'B' : null;
  const team = (k: TeamKey): TeamView => {
    const t = session.teams[k];
    return {
      teamId: t.teamId,
      key: k,
      name: t.name,
      color: t.color,
      roster: t.roster,
      operatorDisplayName: t.operatorDisplayName,
      hasOperator: !!t.operatorUid,
      isMine: myTeam === k,
      consentGiven: !!(t.operatorUid && members[t.operatorUid]?.consent && !members[t.operatorUid]?.consentRevokedAt),
    };
  };
  const last = session.roundBriefs[session.roundBriefs.length - 1];
  const nextRound =
    session.status === 'BETWEEN_ROUNDS' && session.roundBriefs.length < session.rules.totalRounds && (!round || isFinishedState(round.state))
      ? {
          index: session.roundBriefs.length + 1,
          suggestedHidingTeam: last ? (session.rules.alternateRoles ? otherTeam(last.hidingTeam) : last.hidingTeam) : session.rules.initialHidingTeam,
        }
      : null;
  return {
    schemaVersion: 1,
    uid,
    sessionId: session.id,
    renderedAt: new Date(now).toISOString(),
    stateVersion: now * 1000 + ((session.version + (round?.version ?? 0)) % 1000),
    session: {
      title: session.title,
      scheduledDate: session.scheduledDate,
      status: session.status,
      isHost: session.hostUid === uid,
      myTeam,
      totalRounds: session.rules.totalRounds,
      completedRoundCount: session.completedRoundCount,
      rules: { ...session.rules },
      teams: { A: team('A'), B: team('B') },
      revoked: session.revokedAt !== null,
    },
    round: round ? renderRound({ uid, session, round, members, activeClaim: params.activeClaim, now }) : null,
    previousRounds: session.roundBriefs,
    nextRound,
  };
}
