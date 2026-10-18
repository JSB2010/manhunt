import {
  chaseStartDeadline,
  effectiveChaseMs,
  effectiveHeadStartMs,
  hasOpenPause,
  pingDeadline,
  timeCapDeadline,
  totalPauseMs,
} from './clock.js';
import { fail } from './errors.js';
import { rulesFingerprint } from './rules.js';
import {
  isActiveState,
  otherTeam,
  type CaptureClaim,
  type DomainEvent,
  type GpsPoint,
  type NotificationIntent,
  type PauseInterval,
  type PauseKind,
  type RoundDoc,
  type RoundOutcome,
  type RoundResult,
  type Rules,
  type SessionDoc,
  type TeamKey,
} from './types.js';

/**
 * Pure round state machine. Every function receives the current authoritative
 * round document plus server time and returns the next document, audit events
 * and notification intents. Nothing here performs I/O; the service layer runs
 * these inside Firestore transactions.
 */

export interface Transition {
  round: RoundDoc;
  events: DomainEvent[];
  notifications: NotificationIntent[];
}

/** Operational threshold after which a scheduled release is labelled delayed. */
export const DELAYED_DISPATCH_MS = 20_000;
export const PAUSE_REQUEST_TTL_MS = 90_000;

const clone = (r: RoundDoc): RoundDoc => structuredClone(r);

const ev = (
  type: DomainEvent['type'],
  at: number,
  roundId: string,
  actorUid: string | null,
  details: DomainEvent['details'] = {},
): DomainEvent => ({ type, at, roundId, actorUid, details });

const fmtClock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export { fmtClock };

function bothUids(r: RoundDoc): string[] {
  return [r.hiderUid, r.seekerUid].filter((u): u is string => !!u);
}

function notify(r: RoundDoc, toUids: (string | null)[], kind: string, title: string, body: string): NotificationIntent {
  return { toUids: toUids.filter((u): u is string => !!u), kind, title, body, sessionId: r.sessionId, roundId: r.id };
}

export function teamForUid(session: SessionDoc, uid: string): TeamKey | null {
  if (session.teams.A.operatorUid === uid) return 'A';
  if (session.teams.B.operatorUid === uid) return 'B';
  return null;
}

/** Suggested hiding crew for round `index` (1-based) given rules. */
export function suggestedHidingTeam(rules: Rules, index: number, previousHidingTeam: TeamKey | null): TeamKey {
  if (index === 1 || previousHidingTeam === null) return rules.initialHidingTeam;
  return rules.alternateRoles ? otherTeam(previousHidingTeam) : previousHidingTeam;
}

export function createRound(params: {
  id: string;
  session: SessionDoc;
  index: number;
  hidingTeam: TeamKey;
  suggestedHidingTeam: TeamKey;
  overrideByUid: string | null;
  overrideReason: string | null;
  now: number;
}): Transition {
  const { session, now } = params;
  const round: RoundDoc = {
    id: params.id,
    sessionId: session.id,
    index: params.index,
    state: 'READY',
    pausedFromState: null,
    hidingTeam: params.hidingTeam,
    seekingTeam: otherTeam(params.hidingTeam),
    hiderUid: null,
    seekerUid: null,
    rules: structuredClone(session.rules),
    teamNames: { A: session.teams.A.name, B: session.teams.B.name },
    rosterSnapshot: { A: structuredClone(session.teams.A.roster), B: structuredClone(session.teams.B.roster) },
    roleOverride:
      params.hidingTeam !== params.suggestedHidingTeam && params.overrideByUid
        ? { byUid: params.overrideByUid, at: now, reason: params.overrideReason, suggestedHidingTeam: params.suggestedHidingTeam }
        : null,
    ready: { A: null, B: null },
    startWarningsAcknowledged: [],
    roundStartAt: null,
    chaseStartAt: null,
    endedAt: null,
    phaseGeneration: 0,
    pauses: [],
    pendingPauseRequest: null,
    resumeVotes: {},
    nextPingIndex: 0,
    pings: [],
    activeClaimId: null,
    claimSubmittedAt: null,
    claimExpiresAt: null,
    lastClaimOutcome: null,
    result: null,
    abortedReason: null,
    abortedByUid: null,
    active: false,
    nextWakeAt: null,
    lastTickAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const events: DomainEvent[] = [ev('ROUND_CREATED', now, round.id, params.overrideByUid, { index: round.index, hidingTeam: round.hidingTeam })];
  if (round.roleOverride) {
    events.push(
      ev('ROLE_OVERRIDE', now, round.id, params.overrideByUid, {
        suggestedHidingTeam: params.suggestedHidingTeam,
        chosenHidingTeam: params.hidingTeam,
        reason: params.overrideReason,
      }),
    );
  }
  const ops = [session.teams.A.operatorUid, session.teams.B.operatorUid];
  const notifications =
    params.index > 1
      ? [
          {
            toUids: ops.filter((u): u is string => !!u),
            kind: 'NEXT_ROUND',
            title: `Get ready for Round ${params.index}`,
            body: `${round.teamNames[round.hidingTeam]} hides, ${round.teamNames[round.seekingTeam]} seeks. Both operators must tap Ready.`,
            sessionId: session.id,
            roundId: round.id,
          },
        ]
      : [];
  return { round, events, notifications };
}

/** Refresh a not-yet-started round from the session's (edited) setup. */
export function refreshReadyRound(round: RoundDoc, session: SessionDoc, now: number): RoundDoc {
  if (round.state !== 'READY') fail('GAME_CLOSED', 'Round already started; setup is frozen');
  const r = clone(round);
  r.rules = structuredClone(session.rules);
  r.teamNames = { A: session.teams.A.name, B: session.teams.B.name };
  r.rosterSnapshot = { A: structuredClone(session.teams.A.roster), B: structuredClone(session.teams.B.roster) };
  // Any setup change invalidates readiness: both operators must re-confirm.
  r.ready = { A: null, B: null };
  r.updatedAt = now;
  r.version++;
  return r;
}

export function setReady(round: RoundDoc, team: TeamKey, uid: string, ready: boolean, now: number): Transition {
  if (round.state !== 'READY') fail('STALE_PHASE', 'Readiness can only change before the round starts');
  const r = clone(round);
  r.ready[team] = ready ? { uid, at: now } : null;
  r.updatedAt = now;
  r.version++;
  const events = [ev('READY_CHANGED', now, r.id, uid, { team, ready })];
  const notifications: NotificationIntent[] = [];
  if (r.ready.A && r.ready.B) {
    notifications.push({
      toUids: [r.ready.A.uid, r.ready.B.uid],
      kind: 'BOTH_READY',
      title: 'Both crews are ready',
      body: `Round ${r.index} can start.`,
      sessionId: r.sessionId,
      roundId: r.id,
    });
  }
  return { round: r, events, notifications };
}

export function startRound(round: RoundDoc, session: SessionDoc, actorUid: string, warnings: string[], now: number): Transition {
  if (round.state !== 'READY') fail('STALE_PHASE', 'Round is not in READY state');
  if (session.hostUid !== actorUid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the session host can start a round');
  const hiderUid = session.teams[round.hidingTeam].operatorUid;
  const seekerUid = session.teams[round.seekingTeam].operatorUid;
  if (!hiderUid || !seekerUid) fail('GAME_NOT_READY', 'Both crews need a signed-in operator');
  if (hiderUid === seekerUid) fail('GAME_NOT_READY', 'The two operators must be distinct accounts');
  if (!round.ready.A || !round.ready.B) fail('GAME_NOT_READY', 'Both operators must tap Ready');
  if (round.ready[round.hidingTeam]!.uid !== hiderUid || round.ready[round.seekingTeam]!.uid !== seekerUid) {
    fail('GAME_NOT_READY', 'Readiness was recorded by a different operator; both must re-confirm');
  }

  const r = clone(round);
  r.hiderUid = hiderUid;
  r.seekerUid = seekerUid;
  r.state = 'HEAD_START';
  r.roundStartAt = now;
  r.phaseGeneration++;
  r.active = true;
  r.startWarningsAcknowledged = warnings;
  r.updatedAt = now;
  r.version++;
  r.nextWakeAt = chaseStartDeadline(r);
  return {
    round: r,
    events: [
      ev('ROUND_STARTED', now, r.id, actorUid, {
        index: r.index,
        hidingTeam: r.hidingTeam,
        headStartSeconds: r.rules.headStartSeconds,
        warningsAcknowledged: warnings.join(',') || null,
      }),
    ],
    notifications: [
      notify(r, bothUids(r), 'ROUND_STARTED', `Round ${r.index} started`, `Hiding head start: ${fmtClock(r.rules.headStartSeconds)}`),
    ],
  };
}

export type DueEvent =
  | { kind: 'CHASE_START'; at: number }
  | { kind: 'PING'; at: number; pingIndex: number }
  | { kind: 'CLAIM_EXPIRY'; at: number }
  | { kind: 'TIME_CAP'; at: number }
  | { kind: 'PAUSE_REQUEST_EXPIRY'; at: number };

/** Earliest pending scheduled event (regardless of whether it is due yet). */
export function nextScheduledEvent(r: RoundDoc): DueEvent | null {
  const candidates: DueEvent[] = [];
  if (r.pendingPauseRequest && (r.state === 'HEAD_START' || r.state === 'CHASE')) {
    candidates.push({ kind: 'PAUSE_REQUEST_EXPIRY', at: r.pendingPauseRequest.expiresAt });
  }
  switch (r.state) {
    case 'HEAD_START': {
      const at = chaseStartDeadline(r);
      if (at !== null && !hasOpenPause(r.pauses)) candidates.push({ kind: 'CHASE_START', at });
      break;
    }
    case 'CHASE': {
      if (hasOpenPause(r.pauses)) break;
      const cap = timeCapDeadline(r);
      if (cap !== null) candidates.push({ kind: 'TIME_CAP', at: cap });
      const at = pingDeadline(r, r.nextPingIndex);
      if (at !== null) candidates.push({ kind: 'PING', at, pingIndex: r.nextPingIndex });
      break;
    }
    case 'CAPTURE_PENDING': {
      if (r.claimExpiresAt !== null) candidates.push({ kind: 'CLAIM_EXPIRY', at: r.claimExpiresAt });
      break;
    }
    default:
      break;
  }
  const order: Record<DueEvent['kind'], number> = { PAUSE_REQUEST_EXPIRY: 0, CLAIM_EXPIRY: 1, TIME_CAP: 2, CHASE_START: 3, PING: 4 };
  candidates.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
  return candidates[0] ?? null;
}

export function nextDueEvent(r: RoundDoc, now: number): DueEvent | null {
  const e = nextScheduledEvent(r);
  return e && e.at <= now ? e : null;
}

function withWake(r: RoundDoc): RoundDoc {
  r.nextWakeAt = nextScheduledEvent(r)?.at ?? null;
  return r;
}

export function applyChaseStart(round: RoundDoc, at: number, now: number): Transition {
  if (round.state !== 'HEAD_START') fail('STALE_PHASE', 'Not in head start');
  const r = clone(round);
  r.state = 'CHASE';
  r.chaseStartAt = at; // official, pause-adjusted deadline — not processing time
  r.nextPingIndex = 0;
  r.phaseGeneration++;
  r.updatedAt = now;
  r.version++;
  return {
    round: withWake(r),
    events: [ev('CHASE_STARTED', at, r.id, null, { processedLatencyMs: now - at })],
    notifications: [notify(r, [r.hiderUid], 'CHASE_STARTED', 'The chase is on', 'Seekers are now moving. Your first location ping is being released.')],
  };
}

/** Release ping `index` (deadline `scheduledAt`) using the selected sample (or none). */
export function applyPing(round: RoundDoc, index: number, scheduledAt: number, sample: GpsPoint | null, now: number): Transition {
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Pings only release during the chase');
  if (index !== round.nextPingIndex) fail('STALE_PHASE', 'Ping index already processed');
  if (round.pings.some((p) => p.index === index)) fail('STALE_PHASE', 'Duplicate ping');
  const r = clone(round);
  const latency = now - scheduledAt;
  const delayed = latency > DELAYED_DISPATCH_MS;
  r.pings.push({
    index,
    scheduledAt,
    releasedAt: now,
    status: sample ? 'RELEASED' : 'NO_FRESH_FIX',
    delayed,
    dispatchLatencyMs: latency,
    observedAt: sample?.recordedAt ?? null,
    latitude: sample?.latitude ?? null,
    longitude: sample?.longitude ?? null,
    accuracyMeters: sample ? Math.round(sample.horizontalAccuracyMeters * 10) / 10 : null,
    ageSeconds: sample ? Math.max(0, Math.round((scheduledAt - sample.recordedAt) / 1000)) : null,
    sourcePointId: sample?.pointId ?? null,
    phaseGeneration: r.phaseGeneration,
  });
  r.nextPingIndex = index + 1;
  r.updatedAt = now;
  r.version++;
  const events = [
    ev(sample ? 'PING_RELEASED' : 'PING_MISSING', scheduledAt, r.id, null, {
      pingIndex: index,
      dispatchLatencyMs: latency,
      ageSeconds: sample ? Math.max(0, Math.round((scheduledAt - sample.recordedAt) / 1000)) : null,
    }),
  ];
  if (delayed) events.push(ev('PING_DELAYED', now, r.id, null, { pingIndex: index, dispatchLatencyMs: latency }));
  const title = index === 0 ? 'The chase is on' : sample ? 'New location ping' : 'Ping unavailable';
  const body =
    index === 0
      ? sample
        ? 'New hiding-crew location available.'
        : 'First ping unavailable — no fresh GPS fix from the hiding crew.'
      : sample
        ? 'New hiding-crew location ping available.'
        : 'Ping unavailable — no fresh GPS fix.';
  return {
    round: withWake(r),
    events,
    notifications: [notify(r, [r.seekerUid], sample ? 'PING_RELEASED' : 'PING_MISSING', title, body)],
  };
}

export function applyTimeCap(round: RoundDoc, at: number, now: number): Transition {
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Time cap only applies during chase');
  const r = clone(round);
  r.state = 'TIMED_OUT';
  r.endedAt = at;
  r.active = false;
  r.phaseGeneration++;
  r.result = buildBaseResult(r, 'TIMED_OUT', at, null, now);
  r.updatedAt = now;
  r.version++;
  r.nextWakeAt = null;
  return {
    round: r,
    events: [ev('ROUND_TIMED_OUT', at, r.id, null, { observedChaseSeconds: r.result.observedChaseSeconds })],
    notifications: [notify(r, bothUids(r), 'ROUND_TIMED_OUT', `Round ${r.index} timed out`, `Not caught — survived at least ${fmtClock(r.result.observedChaseSeconds)}. Recap is ready.`)],
  };
}

export function submitClaim(round: RoundDoc, claim: CaptureClaim, uid: string, now: number): Transition {
  if (round.state === 'CAPTURE_PENDING' && round.activeClaimId === claim.claimId) {
    return { round, events: [], notifications: [] }; // idempotent replay
  }
  if (round.state === 'CAPTURE_PENDING') fail('ALREADY_CLAIMED', 'Another catch claim is awaiting confirmation');
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Catch claims are accepted only during the chase');
  if (uid !== round.seekerUid || claim.seekerUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the seeking operator can submit a catch');
  if (!claim.photoStoredAt) fail('GAME_NOT_READY', 'Photo upload has not completed');
  const r = clone(round);
  r.state = 'CAPTURE_PENDING';
  r.activeClaimId = claim.claimId;
  r.claimSubmittedAt = now;
  r.claimExpiresAt = now + r.rules.confirmationTimeoutSeconds * 1000;
  r.pauses.push({ id: `cap-${claim.claimId}`, kind: 'CAPTURE', startAt: now, endAt: null, phase: 'CHASE', requestedByUid: uid, confirmedByUid: null, reason: null });
  r.pendingPauseRequest = null;
  r.phaseGeneration++;
  r.updatedAt = now;
  r.version++;
  const chaseSeconds = effectiveChaseMs(r, now) / 1000;
  return {
    round: withWake(r),
    events: [ev('CLAIM_SUBMITTED', now, r.id, uid, { claimId: claim.claimId, chaseSecondsAtClaim: Math.round(chaseSeconds) })],
    notifications: [notify(r, [r.hiderUid], 'CLAIM_SUBMITTED', 'Photo catch submitted', `Review now — claimed at ${fmtClock(chaseSeconds)}.`)],
  };
}

function closeCapturePause(r: RoundDoc, claimId: string, endAt: number) {
  const p = r.pauses.find((x) => x.id === `cap-${claimId}`);
  if (p && p.endAt === null) p.endAt = endAt;
}

export function decideClaim(
  round: RoundDoc,
  claim: CaptureClaim,
  uid: string,
  decision: 'CONFIRM' | 'REJECT',
  reason: string | null,
  now: number,
): Transition {
  if (uid !== round.hiderUid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the hiding operator can confirm or reject a catch');
  if (claim.seekerUid === uid) fail('OPERATOR_NOT_AUTHORIZED', 'An operator cannot review their own claim');
  const capturePending = round.state === 'CAPTURE_PENDING' || (round.state === 'PAUSED' && round.pausedFromState === 'CAPTURE_PENDING');
  if (!capturePending || round.activeClaimId !== claim.claimId || claim.status !== 'PENDING') {
    fail('STALE_PHASE', 'This claim is no longer awaiting a decision');
  }
  if (round.claimExpiresAt !== null && now > round.claimExpiresAt && round.state !== 'PAUSED') {
    fail('CAPTURE_EXPIRED', 'Confirmation window expired');
  }
  const r = clone(round);
  const submittedAt = claim.submittedAt!;
  if (decision === 'CONFIRM') {
    const chaseMs = effectiveChaseMs(r, submittedAt);
    closeCapturePause(r, claim.claimId, now);
    for (const p of r.pauses) if (p.endAt === null) p.endAt = now;
    r.state = 'COMPLETED';
    r.pausedFromState = null;
    r.endedAt = now;
    r.active = false;
    r.phaseGeneration++;
    r.lastClaimOutcome = { claimId: claim.claimId, status: 'CONFIRMED', at: now, reason: null };
    r.result = buildBaseResult(r, 'CAUGHT', submittedAt, { claimId: claim.claimId, chaseMs, confirmedAt: now }, now);
    r.nextWakeAt = null;
    r.updatedAt = now;
    r.version++;
    return {
      round: r,
      events: [ev('CLAIM_CONFIRMED', now, r.id, uid, { claimId: claim.claimId, foundAfterSeconds: Math.round(chaseMs / 1000) })],
      notifications: [
        notify(r, bothUids(r), 'CLAIM_CONFIRMED', 'Catch confirmed', `Official chase time ${fmtClock(chaseMs / 1000)}. Round ${r.index} recap is ready.`),
      ],
    };
  }
  return resumeAfterClaim(r, claim, 'REJECTED', reason, now, uid, now);
}

function resumeAfterClaim(
  r: RoundDoc,
  claim: CaptureClaim,
  status: 'REJECTED' | 'EXPIRED',
  reason: string | null,
  endAt: number,
  actorUid: string | null,
  now: number,
): Transition {
  closeCapturePause(r, claim.claimId, endAt);
  if (r.state === 'PAUSED') {
    r.pausedFromState = 'CHASE';
  } else {
    r.state = 'CHASE';
  }
  r.activeClaimId = null;
  r.claimSubmittedAt = null;
  r.claimExpiresAt = null;
  r.phaseGeneration++;
  r.lastClaimOutcome = { claimId: claim.claimId, status, at: endAt, reason };
  r.updatedAt = now;
  r.version++;
  const type = status === 'REJECTED' ? 'CLAIM_REJECTED' : 'CLAIM_EXPIRED';
  return {
    round: withWake(r),
    events: [ev(type, endAt, r.id, actorUid, { claimId: claim.claimId, reason })],
    notifications: [
      notify(
        r,
        bothUids(r),
        type,
        status === 'REJECTED' ? 'Claim rejected' : 'Claim expired',
        status === 'REJECTED' ? 'Round resumed — the chase clock is running again.' : 'No decision in time — round resumed.',
      ),
    ],
  };
}

export function applyClaimExpiry(round: RoundDoc, claim: CaptureClaim, now: number): Transition {
  if (round.state !== 'CAPTURE_PENDING' || round.activeClaimId !== claim.claimId) fail('STALE_PHASE', 'No pending claim to expire');
  const r = clone(round);
  return resumeAfterClaim(r, claim, 'EXPIRED', null, round.claimExpiresAt ?? now, null, now);
}

export function expirePauseRequest(round: RoundDoc, now: number): Transition {
  const r = clone(round);
  r.pendingPauseRequest = null;
  r.updatedAt = now;
  r.version++;
  return { round: withWake(r), events: [], notifications: [] };
}

function startPause(r: RoundDoc, kind: PauseKind, byUid: string, confirmedByUid: string | null, reason: string | null, now: number): PauseInterval {
  const phase: 'HEAD_START' | 'CHASE' = r.state === 'HEAD_START' ? 'HEAD_START' : 'CHASE';
  const p: PauseInterval = { id: `pause-${r.pauses.length + 1}-${now}`, kind, startAt: now, endAt: null, phase, requestedByUid: byUid, confirmedByUid, reason };
  r.pausedFromState = r.state;
  r.state = 'PAUSED';
  r.pauses.push(p);
  r.pendingPauseRequest = null;
  r.resumeVotes = {};
  r.phaseGeneration++;
  r.nextWakeAt = null;
  return p;
}

/**
 * Pause handling (spec §3.2): SAFETY pauses are immediate from either
 * operator. MANUAL pauses need both operators — the first call proposes,
 * the other operator's call confirms.
 */
export function requestPause(round: RoundDoc, uid: string, team: TeamKey, kind: 'MANUAL' | 'SAFETY', reason: string | null, now: number): Transition {
  if (!bothUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the two round operators can pause');
  const pausable = round.state === 'HEAD_START' || round.state === 'CHASE' || (kind === 'SAFETY' && round.state === 'CAPTURE_PENDING');
  if (!pausable) fail('STALE_PHASE', `Cannot pause in ${round.state}`);
  const r = clone(round);
  r.updatedAt = now;
  r.version++;
  if (kind === 'SAFETY') {
    startPause(r, 'SAFETY', uid, null, reason, now);
    return {
      round: r,
      events: [ev('PAUSE_STARTED', now, r.id, uid, { kind, team, reason })],
      notifications: [notify(r, bothUids(r), 'SAFETY_PAUSE', 'SAFETY PAUSE', `${r.teamNames[team]} paused the round${reason ? `: ${reason}` : ''}. Clock and pings are frozen.`)],
    };
  }
  if (!r.rules.manualPausesEnabled) fail('FORBIDDEN', 'Manual pauses are disabled for this round');
  const pending = r.pendingPauseRequest && r.pendingPauseRequest.expiresAt > now ? r.pendingPauseRequest : null;
  if (pending && pending.byTeam !== team) {
    startPause(r, 'MANUAL', pending.byUid, uid, pending.reason, now);
    return {
      round: r,
      events: [ev('PAUSE_STARTED', now, r.id, uid, { kind, team, reason: pending.reason })],
      notifications: [notify(r, bothUids(r), 'PAUSED', 'Round paused', 'Both operators agreed. Clock and pings are frozen.')],
    };
  }
  r.pendingPauseRequest = { id: `pr-${now}`, byUid: uid, byTeam: team, at: now, expiresAt: now + PAUSE_REQUEST_TTL_MS, reason };
  return {
    round: withWake(r),
    events: [ev('PAUSE_REQUESTED', now, r.id, uid, { team, reason })],
    notifications: [notify(r, bothUids(r).filter((u) => u !== uid), 'PAUSE_REQUESTED', 'Pause requested', `${r.teamNames[team]} asked to pause. Confirm in the app.`)],
  };
}

/** Both operators vote to resume; the pause ends when the second vote arrives. */
export function voteResume(round: RoundDoc, uid: string, team: TeamKey, now: number): Transition {
  if (round.state !== 'PAUSED') fail('STALE_PHASE', 'Round is not paused');
  if (!bothUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the two round operators can resume');
  const r = clone(round);
  r.resumeVotes[team] = now;
  r.updatedAt = now;
  r.version++;
  if (!(r.resumeVotes.A && r.resumeVotes.B)) {
    return {
      round: r,
      events: [ev('RESUME_VOTE', now, r.id, uid, { team })],
      notifications: [notify(r, bothUids(r).filter((u) => u !== uid), 'RESUME_VOTE', 'Ready to resume?', `${r.teamNames[team]} is ready to resume. Tap Resume when your crew is ready.`)],
    };
  }
  let pausedMs = 0;
  for (const p of r.pauses) {
    if (p.endAt === null && p.kind !== 'CAPTURE') {
      pausedMs = Math.max(pausedMs, now - p.startAt);
      p.endAt = now;
    }
  }
  const resumed = r.pausedFromState ?? 'CHASE';
  r.state = resumed;
  r.pausedFromState = null;
  r.resumeVotes = {};
  if (resumed === 'CAPTURE_PENDING' && r.claimExpiresAt !== null) r.claimExpiresAt += pausedMs;
  r.phaseGeneration++;
  return {
    round: withWake(r),
    events: [ev('RESUMED', now, r.id, uid, { pausedSeconds: Math.round(pausedMs / 1000), state: resumed })],
    notifications: [notify(r, bothUids(r), 'RESUMED', 'Round resumed', 'The clock is running again.')],
  };
}

export function abortRound(round: RoundDoc, uid: string | null, reason: string, now: number): Transition {
  if (!isActiveState(round.state)) fail('STALE_PHASE', 'Only an active round can be aborted');
  if (uid !== null && !bothUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the two round operators can abort');
  const r = clone(round);
  for (const p of r.pauses) if (p.endAt === null) p.endAt = now;
  r.state = 'ABORTED';
  r.pausedFromState = null;
  r.endedAt = now;
  r.active = false;
  r.abortedReason = reason;
  r.abortedByUid = uid;
  r.activeClaimId = null;
  r.claimExpiresAt = null;
  r.phaseGeneration++;
  r.result = buildBaseResult(r, 'ABORTED', now, null, now);
  r.nextWakeAt = null;
  r.updatedAt = now;
  r.version++;
  return {
    round: r,
    events: [ev('ROUND_ABORTED', now, r.id, uid, { reason })],
    notifications: [notify(r, bothUids(r), 'ROUND_ABORTED', `Round ${r.index} aborted`, reason)],
  };
}

export function buildBaseResult(
  r: RoundDoc,
  outcome: RoundOutcome,
  endAt: number,
  catchInfo: { claimId: string; chaseMs: number; confirmedAt: number } | null,
  now: number,
): RoundResult {
  const headStartSeconds = Math.round(effectiveHeadStartMs(r, endAt) / 1000);
  let observedChaseSeconds = 0;
  if (outcome === 'CAUGHT' && catchInfo) observedChaseSeconds = Math.round(catchInfo.chaseMs / 1000);
  else if (outcome === 'TIMED_OUT') observedChaseSeconds = r.rules.maxChaseSeconds ?? Math.round(effectiveChaseMs(r, endAt) / 1000);
  else observedChaseSeconds = Math.round(effectiveChaseMs(r, endAt) / 1000);
  return {
    roundId: r.id,
    roundIndex: r.index,
    hidingTeam: r.hidingTeam,
    seekingTeam: r.seekingTeam,
    hidingTeamName: r.teamNames[r.hidingTeam],
    seekingTeamName: r.teamNames[r.seekingTeam],
    hidingRosterSnapshot: r.rosterSnapshot[r.hidingTeam],
    seekingRosterSnapshot: r.rosterSnapshot[r.seekingTeam],
    outcome,
    headStartSeconds,
    observedChaseSeconds,
    isRightCensored: outcome === 'TIMED_OUT',
    officialFoundAt: outcome === 'CAUGHT' ? endAt : null,
    confirmedAt: catchInfo?.confirmedAt ?? null,
    claimId: catchInfo?.claimId ?? null,
    // Pauses up to the official end (a confirmed claim's review window is after the official found time).
    totalPauseSeconds: Math.round(totalPauseMs(r, endAt) / 1000),
    roundElapsedSeconds: r.roundStartAt === null ? 0 : Math.round((endAt - r.roundStartAt) / 1000),
    pingSlots: r.pings.length,
    pingsReleased: r.pings.filter((p) => p.status === 'RELEASED').length,
    pingsMissing: r.pings.filter((p) => p.status === 'NO_FRESH_FIX').length,
    pingsDelayed: r.pings.filter((p) => p.delayed).length,
    hidingDistanceTotalMeters: null,
    hidingDistanceChaseMeters: null,
    seekingDistanceChaseMeters: null,
    gpsCoverageFractionHider: null,
    gpsCoverageFractionSeeker: null,
    routeQualityHider: 'INSUFFICIENT',
    routeQualitySeeker: 'INSUFFICIENT',
    rulesFingerprint: rulesFingerprint(r.rules),
    abortedReason: r.abortedReason,
    resolvedByDispute: false,
    finalizedAt: now,
  };
}

/** Post-game joint dispute resolution: both crews must propose the same outcome. */
export function proposeDisputeResolution(
  round: RoundDoc,
  claim: CaptureClaim,
  uid: string,
  team: TeamKey,
  resolution: 'ACCEPT_AS_CATCH' | 'KEEP_REJECTED',
  now: number,
): { round: RoundDoc; claim: CaptureClaim; events: DomainEvent[]; resolved: boolean } {
  if (isActiveState(round.state) || round.state === 'READY') fail('STALE_PHASE', 'Disputes can be closed only after the round');
  if (!bothUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the two round operators can resolve disputes');
  if (claim.status !== 'REJECTED' && claim.status !== 'EXPIRED') fail('CONFLICT', 'Only rejected or expired claims can be disputed');
  if (claim.dispute?.resolvedAt) fail('CONFLICT', 'Dispute already resolved');
  const c = structuredClone(claim);
  const r = clone(round);
  c.dispute = c.dispute ?? { proposals: {}, resolvedAt: null, resolution: null };
  c.dispute.proposals[team] = { resolution, at: now, uid };
  const events: DomainEvent[] = [ev('DISPUTE_PROPOSED', now, r.id, uid, { claimId: c.claimId, resolution, team })];
  const a = c.dispute.proposals.A?.resolution;
  const b = c.dispute.proposals.B?.resolution;
  let resolved = false;
  if (a && b && a === b) {
    c.dispute.resolvedAt = now;
    c.dispute.resolution = a;
    resolved = true;
    events.push(ev('DISPUTE_RESOLVED', now, r.id, uid, { claimId: c.claimId, resolution: a }));
    if (a === 'ACCEPT_AS_CATCH' && r.result && c.submittedAt !== null && c.officialChaseMsAtClaim !== null) {
      const earlier = r.result.outcome !== 'CAUGHT' || (r.result.officialFoundAt ?? Infinity) > c.submittedAt;
      if (earlier) {
        r.result = {
          ...r.result,
          outcome: 'CAUGHT',
          observedChaseSeconds: Math.round(c.officialChaseMsAtClaim / 1000),
          isRightCensored: false,
          officialFoundAt: c.submittedAt,
          claimId: c.claimId,
          resolvedByDispute: true,
          finalizedAt: now,
        };
        if (r.state !== 'COMPLETED') r.state = 'COMPLETED';
      }
    }
    r.updatedAt = now;
    r.version++;
  }
  return { round: r, claim: c, events, resolved };
}
