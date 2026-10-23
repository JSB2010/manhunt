import { createHash } from 'node:crypto';
import { chaseStartDeadline, effectiveChaseMs, effectiveHeadStartMs, hasOpenPause, pingDeadline, runningSince, timeCapDeadline } from './clock.js';
import { crewOfUid, ownerPersonId, roleOfTeam, roundTeams, sideOfRole, snapshotTeamOf, teamKeysOf } from './crews.js';
import { suggestedHidingTeam } from './engine.js';
import {
  isFinishedState,
  type CaptureClaim,
  type DeviceHealth,
  type MemberDoc,
  type PersonRef,
  type PingRelease,
  type Role,
  type RoundDoc,
  type RoundOutcome,
  type RoundResult,
  type Rules,
  type SeekMode,
  type SessionDoc,
  type Side,
  type TeamKey,
} from './types.js';

/**
 * Per-user sanitized read model (`sessions/{sid}/views/{uid}`).
 *
 * PRIVACY INVARIANT (spec §1, §5.1, §10.2): this renderer is the only code
 * that produces client-subscribable game state. Its inputs contain no raw GPS
 * samples, and the only coordinates it ever emits are *released* ping records.
 * While a round is active, seekers receive released pins only; the hiders'
 * live tracks, latest samples or unreleased positions never appear under any
 * key — no matter how many phones a crew carries. Round artifacts (pins,
 * result) are only rendered for phones in that round's operator snapshot.
 */

const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Ping log entries sent per view (older ones are summarized by `pingCount`). */
export const PING_LOG_LIMIT = 10;

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

export type TrackingState = 'ACTIVE' | 'STARTING' | 'STALE' | 'NO_SIGNAL' | 'STOPPED' | 'PERMISSION_ISSUE' | 'UNKNOWN';

/** Coarse per-crew phone status: never a timestamp or a location. */
export interface CrewStatusView {
  /** phones in the round with ACTIVE tracking */
  live: number;
  total: number;
  /** best state among the crew's phones */
  state: TrackingState;
  issues: string[];
}

export interface RulesView extends Rules {}

export interface OperatorView {
  /** the phone's account id, so any operator can move it between crews (members of the night only) */
  uid: string;
  /** the roster person the phone's owner plays as (links the phone to a roster name, ADR 0018) */
  personId: string | null;
  displayName: string;
  isMe: boolean;
  consentGiven: boolean;
}

export interface TeamView {
  teamId: string;
  key: TeamKey;
  name: string;
  color: string;
  roster: PersonRef[];
  operators: OperatorView[];
  isMine: boolean;
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
  /** null for phones not playing this round (spectators) */
  myRole: Role | null;
  myTeam: TeamKey | null;
  hidingTeam: TeamKey;
  seekingTeams: TeamKey[];
  seekMode: SeekMode;
  rules: RulesView;
  ready: Partial<Record<TeamKey, boolean>>;
  roundStartAt: string | null;
  headStartEndsAt: string | null;
  chaseStartAt: string | null;
  headStartClock: ClockView;
  chaseClock: ClockView | null;
  nextPingAt: string | null;
  nextPingIndex: number;
  /** a ping whose deadline passed without a hider fix; it releases as soon as one gets through */
  waitingPing: { index: number; deadline: string; since: string } | null;
  timeCapAt: string | null;
  pins: PinView[];
  pingLog: PingLogEntry[];
  pingCount: number;
  pause: { kind: string; reason: string | null; startedAt: string; byTeam: TeamKey | null; resumeVotes: Record<Side, boolean>; mySide: Side | null } | null;
  pendingPauseRequest: { byTeam: TeamKey; bySide: Side; at: string; expiresAt: string; reason: string | null; mine: boolean } | null;
  /** the crew whose claim is under review (every phone in the round sees who claimed) */
  claimByTeam: TeamKey | null;
  myClaim: { claimId: string; status: CaptureClaim['status']; submittedAt: string | null; expiresAt: string | null; byMe: boolean } | null;
  captureRequest: { claimId: string; byTeam: TeamKey; submittedAt: string; expiresAt: string | null; chaseSecondsAtClaim: number | null; photoPath: string } | null;
  lastClaimOutcome: { status: string; at: string; reason: string | null } | null;
  crewStatus: Partial<Record<TeamKey, CrewStatusView>>;
  result: RoundResult | null;
  endedAt: string | null;
  phaseGeneration: number;
}

export interface ViewDoc {
  schemaVersion: 2;
  /** content hash (everything but renderedAt); also the REST ETag */
  viewHash?: string;
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
    completedRoundCount: number;
    rules: RulesView;
    teams: Partial<Record<TeamKey, TeamView>>;
    /** reusable night code for adding phones (members only; null once the night ends) */
    joinCode: string | null;
    revoked: boolean;
  };
  round: RoundView | null;
  previousRounds: SessionDoc['roundBriefs'];
  nextRound: { index: number; suggestedHidingTeam: TeamKey } | null;
}

export const STALE_HEARTBEAT_MS = 120_000;
export const NO_SIGNAL_HEARTBEAT_MS = 300_000;

/**
 * Coarse tracking state of one phone, derived from its heartbeat age. `roundStartAt`: a phone
 * whose last report is its Ready check from before the start hasn't begun tracking yet, which
 * is STARTING (then STALE/NO_SIGNAL by age), not STOPPED.
 */
export function trackingState(h: DeviceHealth | undefined, now: number, roundStartAt: number | null = null): TrackingState {
  if (!h) return 'UNKNOWN';
  if (h.permission === 'DENIED' || h.permission === 'RESTRICTED') return 'PERMISSION_ISSUE';
  if (h.lastHeartbeatAt === null) return 'UNKNOWN';
  const preRound = roundStartAt !== null && h.lastHeartbeatAt < roundStartAt;
  if (!h.trackingActive && !preRound) return 'STOPPED';
  if (now - h.lastHeartbeatAt > NO_SIGNAL_HEARTBEAT_MS) return 'NO_SIGNAL';
  if (now - h.lastHeartbeatAt > STALE_HEARTBEAT_MS) return 'STALE';
  return preRound ? 'STARTING' : 'ACTIVE';
}

const STATE_RANK: Record<TrackingState, number> = { ACTIVE: 0, STARTING: 1, STALE: 1, NO_SIGNAL: 2, STOPPED: 3, PERMISSION_ISSUE: 4, UNKNOWN: 5 };

export function crewStatus(uids: readonly string[], members: Record<string, MemberDoc>, now: number, roundStartAt: number | null = null): CrewStatusView {
  const states = uids.map((u) => trackingState(members[u]?.health, now, roundStartAt));
  const issues = new Set<string>();
  for (const u of uids) {
    const h = members[u]?.health;
    if (!h) continue;
    if (!h.preciseLocation) issues.add('PRECISE_LOCATION_OFF');
    if (h.lowPowerMode) issues.add('LOW_POWER_MODE');
  }
  const best = states.length ? states.reduce((a, b) => (STATE_RANK[a] <= STATE_RANK[b] ? a : b)) : 'UNKNOWN';
  return { live: states.filter((s) => s === 'ACTIVE').length, total: uids.length, state: best, issues: [...issues].sort() };
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
  const finished = isFinishedState(r.state);
  const started = r.roundStartAt !== null;
  // Roles come from the round's operator snapshot once it starts; before that,
  // from the phone's current crew. Never from a client payload.
  const myTeam: TeamKey | null = started ? snapshotTeamOf(r, uid) : crewOfUid(session, uid);
  const myRole: Role | null = roleOfTeam(r, myTeam);
  const inRound = myRole !== null;
  const mySide: Side | null = myRole ? sideOfRole(myRole) : null;

  const headStartPauses = r.pauses.filter((p) => p.phase === 'HEAD_START');
  const chasePauses = r.pauses.filter((p) => p.phase === 'CHASE');
  const capturePendingOrPaused = r.state === 'CAPTURE_PENDING' || r.state === 'PAUSED';

  const headStartAcc = effectiveHeadStartMs(r, now);
  const headStartClock: ClockView =
    r.state === 'HEAD_START' && started ? clockView(headStartPauses, r.roundStartAt, headStartAcc, now, false) : { accumulatedMs: headStartAcc, runningSince: null };

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

  // Released pins: visible to the round's phones (to hiders they are their own
  // already-disclosed positions). After the round, the full released history.
  const pins = inRound ? visiblePins(r.pings, finished ? null : r.rules.visiblePingHistoryCount) : [];
  const pingLog: PingLogEntry[] = (inRound ? r.pings : []).slice(-PING_LOG_LIMIT).map((p) => ({
    index: p.index,
    scheduledAt: iso(p.scheduledAt)!,
    releasedAt: iso(p.releasedAt)!,
    status: p.status,
    ageSeconds: p.ageSeconds,
    accuracyMeters: p.accuracyMeters,
    delayed: p.delayed,
  }));

  const openNonCapturePause = r.pauses.find((p) => p.endAt === null && p.kind !== 'CAPTURE');

  let myClaim: RoundView['myClaim'] = null;
  let captureRequest: RoundView['captureRequest'] = null;
  let claimByTeam: TeamKey | null = null;
  if (activeClaim && activeClaim.roundId === r.id && inRound) {
    if (activeClaim.status === 'PENDING') claimByTeam = activeClaim.seekerTeam;
    if (myRole === 'SEEKING' && activeClaim.seekerTeam === myTeam) {
      myClaim = {
        claimId: activeClaim.claimId,
        status: activeClaim.status,
        submittedAt: iso(activeClaim.submittedAt),
        expiresAt: iso(r.claimExpiresAt),
        byMe: activeClaim.seekerUid === uid,
      };
    }
    if (myRole === 'HIDING' && activeClaim.status === 'PENDING' && activeClaim.submittedAt !== null) {
      captureRequest = {
        claimId: activeClaim.claimId,
        byTeam: activeClaim.seekerTeam,
        submittedAt: iso(activeClaim.submittedAt)!,
        expiresAt: iso(r.claimExpiresAt),
        chaseSecondsAtClaim: activeClaim.officialChaseMsAtClaim === null ? null : Math.round(activeClaim.officialChaseMsAtClaim / 1000),
        photoPath: `/v1/sessions/${r.sessionId}/rounds/${r.id}/captures/${activeClaim.claimId}/photo`,
      };
    }
  }

  const statusOf = (k: TeamKey) =>
    started ? crewStatus(r.operatorsByTeam[k] ?? [], members, now, r.roundStartAt) : crewStatus(session.teams[k]?.operatorUids ?? [], members, now);

  return {
    id: r.id,
    index: r.index,
    state: r.state,
    pausedFromState: r.pausedFromState,
    myRole,
    myTeam,
    hidingTeam: r.hidingTeam,
    seekingTeams: [...r.seekingTeams],
    seekMode: r.seekMode,
    rules: { ...r.rules },
    ready: Object.fromEntries(roundTeams(r).map((k) => [k, !!r.ready[k]])),
    roundStartAt: iso(r.roundStartAt),
    headStartEndsAt: iso(headStartEndsAt),
    chaseStartAt: iso(r.chaseStartAt),
    headStartClock,
    chaseClock,
    nextPingAt: iso(nextPingAt),
    nextPingIndex: r.nextPingIndex,
    waitingPing: inRound && r.waitingPing ? { index: r.waitingPing.index, deadline: iso(r.waitingPing.deadline)!, since: iso(r.waitingPing.since)! } : null,
    timeCapAt: iso(active ? timeCapDeadline(r) : null),
    pins,
    pingLog,
    pingCount: inRound ? r.pings.length : 0,
    pause:
      r.state === 'PAUSED' && openNonCapturePause
        ? {
            kind: openNonCapturePause.kind,
            reason: openNonCapturePause.reason,
            startedAt: iso(openNonCapturePause.startAt)!,
            byTeam: openNonCapturePause.requestedByUid ? snapshotTeamOf(r, openNonCapturePause.requestedByUid) : null,
            resumeVotes: { HIDERS: !!r.resumeVotes.HIDERS, SEEKERS: !!r.resumeVotes.SEEKERS },
            mySide,
          }
        : null,
    pendingPauseRequest:
      r.pendingPauseRequest && r.pendingPauseRequest.expiresAt > now
        ? {
            byTeam: r.pendingPauseRequest.byTeam,
            bySide: r.pendingPauseRequest.bySide,
            at: iso(r.pendingPauseRequest.at)!,
            expiresAt: iso(r.pendingPauseRequest.expiresAt)!,
            reason: r.pendingPauseRequest.reason,
            mine: r.pendingPauseRequest.bySide === mySide,
          }
        : null,
    claimByTeam,
    myClaim,
    captureRequest,
    lastClaimOutcome: r.lastClaimOutcome ? { status: r.lastClaimOutcome.status, at: iso(r.lastClaimOutcome.at)!, reason: r.lastClaimOutcome.reason } : null,
    crewStatus: Object.fromEntries(roundTeams(r).map((k) => [k, statusOf(k)])),
    result: finished && inRound ? r.result : null,
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
  const myTeam = crewOfUid(session, uid);
  const team = (k: TeamKey): TeamView => {
    const t = session.teams[k]!;
    return {
      teamId: t.teamId,
      key: k,
      name: t.name,
      color: t.color,
      roster: t.roster,
      operators: t.operatorUids.map((u) => ({
        uid: u,
        personId: members[u] ? ownerPersonId(session, members[u]!) : null,
        displayName: members[u]?.displayName ?? 'Phone',
        isMe: u === uid,
        consentGiven: !!(members[u]?.consent && !members[u]?.consentRevokedAt),
      })),
      isMine: myTeam === k,
    };
  };
  const roundOpen = !!round && !isFinishedState(round.state);
  const ended = session.status === 'COMPLETED' || session.revokedAt !== null;
  const nextRound = !ended && !roundOpen ? { index: session.roundIds.length + 1, suggestedHidingTeam: suggestedHidingTeam(session) } : null;
  return {
    schemaVersion: 2,
    uid,
    sessionId: session.id,
    renderedAt: new Date(now).toISOString(),
    // Orders snapshots from the listener and REST: session/round versions only grow.
    stateVersion: session.version * 100_000 + (round?.version ?? 0),
    session: {
      title: session.title,
      scheduledDate: session.scheduledDate,
      status: session.status,
      isHost: session.hostUid === uid,
      myTeam,
      completedRoundCount: session.completedRoundCount,
      rules: { ...session.rules },
      teams: Object.fromEntries(teamKeysOf(session).map((k) => [k, team(k)])),
      joinCode: ended ? null : session.joinCode,
      revoked: session.revokedAt !== null,
    },
    round: round ? renderRound({ uid, session, round, members, activeClaim: params.activeClaim, now }) : null,
    previousRounds: session.roundBriefs,
    nextRound,
  };
}

/** Content hash of a rendered view, ignoring render time: equal hashes mean nothing a phone sees changed. */
export function viewHash(v: ViewDoc): string {
  const { renderedAt: _r, viewHash: _h, ...content } = v;
  return createHash('sha256').update(JSON.stringify(content)).digest('base64url').slice(0, 22);
}

// ---------------------------------------------------------------------------
// Live Activity (Lock Screen, Dynamic Island, Smart Stack, CarPlay) — ADR 0017
// ---------------------------------------------------------------------------

export type LiveActivityPhase = 'HEAD_START' | 'CHASE' | 'CAPTURE_PENDING' | 'PAUSED' | 'ENDED';

/** Static part of a round's Live Activity (`RoundActivityAttributes` on iOS). */
export interface LiveActivityAttributes {
  sessionId: string;
  roundId: string;
  roundIndex: number;
  role: Role;
  crew: TeamKey;
  crewName: string;
}

/**
 * Dynamic part (`RoundActivityAttributes.ContentState`). Times are epoch seconds on the
 * phone's clock so the system can run the timers on its own between updates. No
 * coordinates, rosters or free-text reasons: a Live Activity is readable on a locked
 * phone by anyone standing next to it.
 */
export interface LiveActivityState {
  phase: LiveActivityPhase;
  /** while PAUSED: the phase the clocks froze in */
  pausedPhase: 'HEAD_START' | 'CHASE' | null;
  safetyPause: boolean;
  /** head start running: countdown target */
  headStartEndsAt: number | null;
  /** head start frozen (paused): seconds left */
  headStartRemaining: number | null;
  /** chase clock running: it reads now − chaseStartedAt */
  chaseStartedAt: number | null;
  /** chase clock frozen (claim review, pause, end): seconds */
  chaseElapsed: number | null;
  nextPingAt: number | null;
  nextPingIndex: number;
  timeCapAt: number | null;
  /** the latest ping slot (when and whether it had a fix) — never where */
  lastPing: { index: number; at: number; missing: boolean } | null;
  pingWaiting: boolean;
  /** a catch claim under review */
  claim: { crew: TeamKey; expiresAt: number | null } | null;
  outcome: { result: RoundOutcome; creditCrews: TeamKey[] } | null;
}

/** Live Activity attributes for a phone playing the view's round, else null. */
export function liveActivityAttributes(view: ViewDoc): LiveActivityAttributes | null {
  const r = view.round;
  if (!r || !r.myRole || !r.myTeam || r.state === 'READY') return null;
  return {
    sessionId: view.sessionId,
    roundId: r.id,
    roundIndex: r.index,
    role: r.myRole,
    crew: r.myTeam,
    crewName: view.session.teams[r.myTeam]?.name ?? `Crew ${r.myTeam}`,
  };
}

const OUTCOME_OF_STATE: Partial<Record<RoundDoc['state'], RoundOutcome>> = { COMPLETED: 'CAUGHT', TIMED_OUT: 'TIMED_OUT', ABORTED: 'ABORTED' };

/**
 * Live Activity content for one phone, rendered from that phone's own sanitized round view
 * (so it can never carry more than the view). `clockOffsetMs` is the phone's clock minus
 * server time, as the phone reported it; null when the phone isn't playing the round.
 */
export function liveActivityState(r: RoundView, clockOffsetMs = 0): LiveActivityState | null {
  if (!r.myRole || r.state === 'READY' || r.roundStartAt === null) return null;
  const at = (s: string | null) => (s === null ? null : (Date.parse(s) + clockOffsetMs) / 1000);
  const ended = isFinishedState(r.state);
  const phase: LiveActivityPhase = ended ? 'ENDED' : (r.state as LiveActivityPhase);
  const chase = r.chaseClock;
  const chaseRunning = !ended && !!chase?.runningSince;
  const last = r.pingLog[r.pingLog.length - 1];
  return {
    phase,
    pausedPhase: r.state === 'PAUSED' ? (r.pausedFromState === 'HEAD_START' ? 'HEAD_START' : 'CHASE') : null,
    safetyPause: r.state === 'PAUSED' && r.pause?.kind === 'SAFETY',
    headStartEndsAt: r.state === 'HEAD_START' ? at(r.headStartEndsAt) : null,
    headStartRemaining:
      r.state === 'PAUSED' && r.pausedFromState === 'HEAD_START' ? Math.max(0, r.rules.headStartSeconds - r.headStartClock.accumulatedMs / 1000) : null,
    chaseStartedAt: chaseRunning ? (Date.parse(chase!.runningSince!) - chase!.accumulatedMs + clockOffsetMs) / 1000 : null,
    chaseElapsed: ended ? (r.result?.observedChaseSeconds ?? (chase ? chase.accumulatedMs / 1000 : 0)) : chase && !chaseRunning ? chase.accumulatedMs / 1000 : null,
    nextPingAt: r.state === 'CHASE' ? at(r.nextPingAt) : null,
    nextPingIndex: r.nextPingIndex,
    timeCapAt: r.state === 'CHASE' ? at(r.timeCapAt) : null,
    lastPing: last ? { index: last.index, at: at(last.releasedAt)!, missing: last.status !== 'RELEASED' } : null,
    pingWaiting: !ended && r.waitingPing !== null,
    claim: !ended && r.claimByTeam ? { crew: r.claimByTeam, expiresAt: at(r.captureRequest?.expiresAt ?? r.myClaim?.expiresAt ?? null) } : null,
    outcome: ended ? { result: r.result?.outcome ?? OUTCOME_OF_STATE[r.state]!, creditCrews: [...(r.result?.catchCreditTeams ?? [])] } : null,
  };
}

/** How long past an expected update (chase start, ping, claim deadline) a Live Activity may go before it shows as out of date. */
export const LIVE_ACTIVITY_STALE_GRACE_S = 90;

/**
 * When the content goes stale (epoch seconds, phone clock): the next moment an update
 * is due, plus a grace period. Null when nothing is due (paused, waiting ping, ended).
 */
export function liveActivityStaleDate(s: LiveActivityState): number | null {
  const due =
    s.phase === 'HEAD_START' ? [s.headStartEndsAt] : s.phase === 'CHASE' && !s.pingWaiting ? [s.nextPingAt, s.timeCapAt] : s.phase === 'CAPTURE_PENDING' ? [s.claim?.expiresAt ?? null] : [];
  const next = due.filter((t): t is number => t !== null);
  return next.length ? Math.min(...next) + LIVE_ACTIVITY_STALE_GRACE_S : null;
}
