import {
  chaseStartDeadline,
  effectiveChaseMs,
  effectiveHeadStartMs,
  hasOpenPause,
  pingDeadline,
  timeCapDeadline,
  totalPauseMs,
} from './clock.js';
import { crewColourName, hiderUids, isPlural, roleOfTeam, roundTeams, roundUids, seekerUids, sideOfRole, snapshotTeamOf, teamKeysOf } from './crews.js';
import { fail } from './errors.js';
import { rulesFingerprint } from './rules.js';
import {
  isActiveState,
  type CaptureClaim,
  type DomainEvent,
  type GpsPoint,
  type MemberDoc,
  type NotificationIntent,
  type PauseInterval,
  type PauseKind,
  type PingRelease,
  type RoundBrief,
  type RoundDoc,
  type RoundOutcome,
  type RoundResult,
  type SeekMode,
  type SessionDoc,
  type TeamKey,
} from './types.js';

/**
 * Pure round state machine. Every function receives the current authoritative
 * round document plus server time and returns the next document, audit events
 * and notification intents. Nothing here performs I/O; the service layer runs
 * these inside Firestore transactions.
 *
 * Authority: any operator phone of a crew acts for that crew, and every
 * in-round check uses the round's operator snapshot (`round.operatorsByTeam`).
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

function notify(r: RoundDoc, toUids: (string | null)[], kind: string, title: string, body: string): NotificationIntent {
  return { toUids: [...new Set(toUids.filter((u): u is string => !!u))], kind, title, body, sessionId: r.sessionId, roundId: r.id };
}

// Crews are named after their people (ADR 0019): verbs agree with how many ("Sasha hides", "Sasha & Marco hide").
const name = (r: Pick<RoundDoc, 'teamNames'>, k: TeamKey) => r.teamNames[k] ?? crewColourName(k);
const joinNames = (r: Pick<RoundDoc, 'teamNames'>, ks: TeamKey[]) => ks.map((k) => name(r, k)).join(' and ');
const verb = (r: Pick<RoundDoc, 'rosterSnapshot'>, ks: TeamKey[], one: string, many: string) =>
  ks.length > 1 || ks.some((k) => isPlural(r.rosterSnapshot[k])) ? many : one;

/**
 * Suggested hiding crew for the next round: the crew that has hidden least so
 * far; ties go to the crew whose last hide was longest ago (never hid first),
 * then key order.
 */
export function suggestedHidingTeam(session: SessionDoc): TeamKey {
  const keys = teamKeysOf(session);
  const stats = keys.map((k) => {
    const hides = session.roundBriefs.filter((b) => b.hidingTeam === k && b.outcome !== 'ABORTED');
    return { k, count: hides.length, last: hides.length ? Math.max(...hides.map((b) => b.index)) : -1 };
  });
  stats.sort((a, b) => a.count - b.count || a.last - b.last || a.k.localeCompare(b.k));
  return stats[0]!.k;
}

/** Notification recipients before a round starts: every operator phone of the night. */
const allOperators = (session: SessionDoc) => teamKeysOf(session).flatMap((k) => session.teams[k]!.operatorUids);

export function createRound(params: {
  id: string;
  session: SessionDoc;
  index: number;
  hidingTeam: TeamKey;
  seekMode: SeekMode;
  actorUid: string | null;
  now: number;
}): Transition {
  const { session, now } = params;
  const keys = teamKeysOf(session);
  if (!keys.includes(params.hidingTeam)) fail('VALIDATION_FAILED', 'That crew is not part of this night');
  const round: RoundDoc = {
    id: params.id,
    sessionId: session.id,
    index: params.index,
    state: 'READY',
    pausedFromState: null,
    hidingTeam: params.hidingTeam,
    seekingTeams: keys.filter((k) => k !== params.hidingTeam),
    seekMode: params.seekMode,
    operatorsByTeam: {},
    rules: structuredClone(session.rules),
    teamNames: Object.fromEntries(keys.map((k) => [k, session.teams[k]!.name])),
    rosterSnapshot: Object.fromEntries(keys.map((k) => [k, structuredClone(session.teams[k]!.roster)])),
    ready: {},
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
    waitingPing: null,
    routeSourceUids: {},
    activeClaimId: null,
    claimSubmittedAt: null,
    claimExpiresAt: null,
    lastClaimOutcome: null,
    result: null,
    abortedReason: null,
    abortedByUid: null,
    active: false,
    summaryReady: null,
    nextWakeAt: null,
    lastTickAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const events: DomainEvent[] = [
    ev('ROUND_CREATED', now, round.id, params.actorUid, { index: round.index, hidingTeam: round.hidingTeam, seekMode: round.seekMode }),
  ];
  const notifications =
    params.index > 1
      ? [
          {
            toUids: allOperators(session),
            kind: 'NEXT_ROUND',
            title: `Get ready for Round ${params.index}`,
            body: `${name(round, round.hidingTeam)} ${verb(round, [round.hidingTeam], 'hides', 'hide')}, ${joinNames(round, round.seekingTeams)} ${verb(round, round.seekingTeams, 'seeks', 'seek')}. Tap Ready.`,
            sessionId: session.id,
            roundId: round.id,
          },
        ]
      : [];
  return { round, events, notifications };
}

/**
 * Refresh a not-yet-started round from the session's (edited) setup, optionally
 * re-targeting who hides. Ready marks survive only for crews whose marking phone
 * is still on that crew.
 */
export function refreshReadyRound(
  round: RoundDoc,
  session: SessionDoc,
  now: number,
  change: { hidingTeam?: TeamKey | undefined; seekMode?: SeekMode | undefined } = {},
): RoundDoc {
  if (round.state !== 'READY') fail('GAME_CLOSED', 'Round already started; setup is frozen');
  const keys = teamKeysOf(session);
  const r = clone(round);
  const hidingTeam = change.hidingTeam ?? (keys.includes(r.hidingTeam) ? r.hidingTeam : keys[0]!);
  if (!keys.includes(hidingTeam)) fail('VALIDATION_FAILED', 'That crew is not part of this night');
  // Ready marks agree to roles and rules: either changing clears them.
  const rolesChanged = hidingTeam !== r.hidingTeam || JSON.stringify(r.rules) !== JSON.stringify(session.rules);
  r.hidingTeam = hidingTeam;
  r.seekingTeams = keys.filter((k) => k !== hidingTeam);
  if (change.seekMode) r.seekMode = change.seekMode;
  r.rules = structuredClone(session.rules);
  r.teamNames = Object.fromEntries(keys.map((k) => [k, session.teams[k]!.name]));
  r.rosterSnapshot = Object.fromEntries(keys.map((k) => [k, structuredClone(session.teams[k]!.roster)]));
  const ready: RoundDoc['ready'] = {};
  if (!rolesChanged) {
    for (const k of keys) {
      const mark = r.ready[k];
      if (mark && session.teams[k]!.operatorUids.includes(mark.uid)) ready[k] = mark;
    }
  }
  r.ready = ready;
  r.updatedAt = now;
  r.version++;
  return r;
}

export function setReady(round: RoundDoc, team: TeamKey, uid: string, ready: boolean, now: number): Transition {
  if (round.state !== 'READY') fail('STALE_PHASE', 'Readiness can only change before the round starts');
  if (!roundTeams(round).includes(team)) fail('VALIDATION_FAILED', 'That crew is not playing this round');
  const r = clone(round);
  r.ready[team] = ready ? { uid, at: now } : null;
  r.updatedAt = now;
  r.version++;
  const events = [ev('READY_CHANGED', now, r.id, uid, { team, ready })];
  const notifications: NotificationIntent[] = [];
  const marks = roundTeams(r).map((k) => r.ready[k]);
  if (ready && marks.every((m) => !!m)) {
    notifications.push(notify(r, marks.map((m) => m!.uid), 'ALL_READY', 'Every crew is ready', `Round ${r.index} can start.`));
  }
  return { round: r, events, notifications };
}

/**
 * Start a READY round. Any operator of a playing crew may start it once every
 * playing crew has a ready phone. Freezes the operator snapshot: each crew's
 * phones that are active members with tracking consent (`eligibleUids`).
 */
export function startRound(
  round: RoundDoc,
  session: SessionDoc,
  actorUid: string,
  eligibleUids: ReadonlySet<string>,
  warnings: string[],
  now: number,
): Transition {
  if (round.state !== 'READY') fail('STALE_PHASE', 'Round is not in READY state');
  const teams = roundTeams(round);
  const actorTeam = teams.find((k) => session.teams[k]?.operatorUids.includes(actorUid));
  if (!actorTeam) fail('OPERATOR_NOT_AUTHORIZED', 'Only an operator of a playing crew can start the round');
  const operatorsByTeam: RoundDoc['operatorsByTeam'] = {};
  for (const k of teams) {
    const crew = session.teams[k];
    if (!crew) fail('GAME_NOT_READY', 'A playing crew is missing');
    const phones = crew!.operatorUids.filter((u) => eligibleUids.has(u));
    if (!phones.length) fail('GAME_NOT_READY', `${crew!.name} ${isPlural(crew!.roster) ? 'need' : 'needs'} a phone in the game`);
    const mark = round.ready[k];
    if (!mark) fail('GAME_NOT_READY', 'Every crew must tap Ready');
    if (!phones.includes(mark!.uid)) fail('GAME_NOT_READY', `The phone that marked ${crew!.name} ready left the crew. Tap Ready again.`);
    operatorsByTeam[k] = phones;
  }
  const r = clone(round);
  r.operatorsByTeam = operatorsByTeam;
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
        seekingTeams: r.seekingTeams.join(','),
        seekMode: r.seekMode,
        phones: roundUids(r).length,
        headStartSeconds: r.rules.headStartSeconds,
        warningsAcknowledged: warnings.join(',') || null,
      }),
    ],
    notifications: [notify(r, roundUids(r), 'ROUND_STARTED', `Round ${r.index} started`, `Hiding head start: ${fmtClock(r.rules.headStartSeconds)}`)],
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
    notifications: [notify(r, hiderUids(r), 'CHASE_STARTED', 'The chase is on', 'Seekers are moving. Your first ping is going out.')],
  };
}

function pingRecord(
  r: RoundDoc,
  index: number,
  scheduledAt: number,
  sample: GpsPoint | null,
  now: number,
  ageFrom: number,
): PingRelease {
  const latency = now - scheduledAt;
  return {
    index,
    scheduledAt,
    releasedAt: now,
    status: sample ? 'RELEASED' : 'NO_FRESH_FIX',
    delayed: latency > DELAYED_DISPATCH_MS,
    dispatchLatencyMs: latency,
    observedAt: sample?.recordedAt ?? null,
    latitude: sample?.latitude ?? null,
    longitude: sample?.longitude ?? null,
    accuracyMeters: sample ? Math.round(sample.horizontalAccuracyMeters * 10) / 10 : null,
    ageSeconds: sample ? Math.max(0, Math.round((ageFrom - sample.recordedAt) / 1000)) : null,
    sourcePointId: sample?.pointId ?? null,
    sourceUid: sample?.operatorUid ?? null,
    phaseGeneration: r.phaseGeneration,
  };
}

/**
 * A waiting ping that never got a fix is closed as NO_FRESH_FIX (when the next
 * deadline supersedes it, or when the round ends) so ping counts stay exact.
 */
function closeWaitingPing(r: RoundDoc, now: number, events: DomainEvent[]) {
  const w = r.waitingPing;
  if (!w) return;
  r.pings.push(pingRecord(r, w.index, w.deadline, null, now, now));
  r.waitingPing = null;
  events.push(ev('PING_MISSING', now, r.id, null, { pingIndex: w.index, waitedMs: now - w.since }));
}

/**
 * Process the deadline of ping `index`. With an eligible fix it is released
 * immediately; otherwise it becomes the round's waiting ping (ADR 0015) and is
 * released by `applyLateRelease` as soon as a fresh hider fix arrives. A still
 * waiting earlier ping is superseded (closed as NO_FRESH_FIX) — pings never pile up.
 */
export function applyPing(round: RoundDoc, index: number, scheduledAt: number, sample: GpsPoint | null, now: number): Transition {
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Pings only release during the chase');
  if (index !== round.nextPingIndex) fail('STALE_PHASE', 'Ping index already processed');
  if (round.pings.some((p) => p.index === index) || round.waitingPing?.index === index) fail('STALE_PHASE', 'Duplicate ping');
  const r = clone(round);
  const events: DomainEvent[] = [];
  closeWaitingPing(r, now, events);
  r.nextPingIndex = index + 1;
  r.updatedAt = now;
  r.version++;
  const latency = now - scheduledAt;
  if (!sample) {
    r.waitingPing = { index, deadline: scheduledAt, since: now };
    events.push(ev('PING_WAITING', scheduledAt, r.id, null, { pingIndex: index, dispatchLatencyMs: latency }));
    return {
      round: withWake(r),
      events,
      notifications: [
        notify(r, hiderUids(r), 'PING_WAITING', 'Seekers are waiting on your ping', 'No fresh GPS reached the server. Get a signal — the ping goes out as soon as it does.'),
      ],
    };
  }
  const rec = pingRecord(r, index, scheduledAt, sample, now, scheduledAt);
  r.pings.push(rec);
  events.push(ev('PING_RELEASED', scheduledAt, r.id, null, { pingIndex: index, dispatchLatencyMs: latency, ageSeconds: rec.ageSeconds }));
  if (rec.delayed) events.push(ev('PING_DELAYED', now, r.id, null, { pingIndex: index, dispatchLatencyMs: latency }));
  return {
    round: withWake(r),
    events,
    notifications: [notify(r, seekerUids(r), 'PING_RELEASED', index === 0 ? 'The chase is on' : 'New ping', 'New hiding-crew location available.')],
  };
}

/**
 * Release the waiting ping with the hiders' current fix (selected by
 * `selectLateSample`). Only during an un-paused chase; the ping's age is
 * measured against the release time, and it is labelled delayed.
 */
export function applyLateRelease(round: RoundDoc, sample: GpsPoint, now: number): Transition {
  const w = round.waitingPing;
  if (!w) fail('STALE_PHASE', 'No ping is waiting');
  if (round.state !== 'CHASE' || hasOpenPause(round.pauses)) fail('STALE_PHASE', 'Pings release only during the chase');
  const r = clone(round);
  const rec = pingRecord(r, w!.index, w!.deadline, sample, now, now);
  rec.delayed = true;
  r.pings.push(rec);
  r.waitingPing = null;
  r.updatedAt = now;
  r.version++;
  return {
    round: withWake(r),
    events: [
      ev('PING_RELEASED', now, r.id, null, { pingIndex: w!.index, dispatchLatencyMs: rec.dispatchLatencyMs, ageSeconds: rec.ageSeconds, late: true }),
      ev('PING_DELAYED', now, r.id, null, { pingIndex: w!.index, dispatchLatencyMs: rec.dispatchLatencyMs }),
    ],
    notifications: [notify(r, seekerUids(r), 'PING_LATE', 'Late ping', 'The hiders’ GPS got through — new location available.')],
  };
}

function endRound(r: RoundDoc, now: number, events: DomainEvent[]) {
  closeWaitingPing(r, now, events);
  for (const p of r.pauses) if (p.endAt === null) p.endAt = now;
  r.pausedFromState = null;
  r.active = false;
  r.summaryReady = false;
  r.pendingPauseRequest = null;
  r.phaseGeneration++;
  r.nextWakeAt = null;
  r.updatedAt = now;
  r.version++;
}

export function applyTimeCap(round: RoundDoc, at: number, now: number): Transition {
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Time cap only applies during chase');
  const r = clone(round);
  const events: DomainEvent[] = [];
  r.state = 'TIMED_OUT';
  r.endedAt = at;
  endRound(r, now, events);
  r.result = buildBaseResult(r, 'TIMED_OUT', at, null, now);
  events.push(ev('ROUND_TIMED_OUT', at, r.id, null, { observedChaseSeconds: r.result.observedChaseSeconds }));
  return {
    round: r,
    events,
    notifications: [
      notify(r, roundUids(r), 'ROUND_TIMED_OUT', `Round ${r.index} timed out`, `Not caught — survived at least ${fmtClock(r.result.observedChaseSeconds)}.`),
    ],
  };
}

export function submitClaim(round: RoundDoc, claim: CaptureClaim, uid: string, now: number): Transition {
  if (round.state === 'CAPTURE_PENDING' && round.activeClaimId === claim.claimId) {
    return { round, events: [], notifications: [] }; // idempotent replay
  }
  if (round.state === 'CAPTURE_PENDING') fail('ALREADY_CLAIMED', 'Another catch claim is awaiting confirmation');
  if (round.state !== 'CHASE') fail('STALE_PHASE', 'Catch claims are accepted only during the chase');
  if (!seekerUids(round).includes(uid) || claim.seekerUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only a seeking crew can submit a catch');
  if (claim.seekerTeam !== snapshotTeamOf(round, uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Claim crew mismatch');
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
    events: [ev('CLAIM_SUBMITTED', now, r.id, uid, { claimId: claim.claimId, team: claim.seekerTeam, chaseSecondsAtClaim: Math.round(chaseSeconds) })],
    notifications: [
      notify(r, hiderUids(r), 'CLAIM_SUBMITTED', 'Photo catch submitted', `${name(r, claim.seekerTeam)} ${verb(r, [claim.seekerTeam], 'claims', 'claim')} a catch at ${fmtClock(chaseSeconds)}. Review now.`),
      notify(
        r,
        seekerUids(r).filter((u) => u !== uid),
        'CLAIM_SUBMITTED',
        'Catch claimed',
        `${name(r, claim.seekerTeam)} submitted a photo catch. The clock is frozen while the hiders review.`,
      ),
    ],
  };
}

function closeCapturePause(r: RoundDoc, claimId: string, endAt: number) {
  const p = r.pauses.find((x) => x.id === `cap-${claimId}`);
  if (p && p.endAt === null) p.endAt = endAt;
}

/** Crews credited with a confirmed catch: attribution, never a round winner. */
export function catchCredit(r: Pick<RoundDoc, 'seekMode' | 'seekingTeams'>, claimTeam: TeamKey): TeamKey[] {
  return r.seekMode === 'RACE' ? [claimTeam] : [...r.seekingTeams];
}

export function decideClaim(
  round: RoundDoc,
  claim: CaptureClaim,
  uid: string,
  decision: 'CONFIRM' | 'REJECT',
  reason: string | null,
  now: number,
): Transition {
  if (!hiderUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the hiding crew can confirm or reject a catch');
  if (claim.seekerUid === uid) fail('OPERATOR_NOT_AUTHORIZED', 'An operator cannot review their own claim');
  const capturePending = round.state === 'CAPTURE_PENDING' || (round.state === 'PAUSED' && round.pausedFromState === 'CAPTURE_PENDING');
  if (!capturePending || round.activeClaimId !== claim.claimId || claim.status !== 'PENDING') {
    fail('STALE_PHASE', 'This claim was already decided');
  }
  if (round.claimExpiresAt !== null && now > round.claimExpiresAt && round.state !== 'PAUSED') {
    fail('CAPTURE_EXPIRED', 'Confirmation window expired');
  }
  const r = clone(round);
  const submittedAt = claim.submittedAt!;
  if (decision === 'CONFIRM') {
    const chaseMs = effectiveChaseMs(r, submittedAt);
    closeCapturePause(r, claim.claimId, now);
    const events: DomainEvent[] = [];
    r.state = 'COMPLETED';
    r.endedAt = now;
    endRound(r, now, events);
    r.lastClaimOutcome = { claimId: claim.claimId, status: 'CONFIRMED', at: now, reason: null };
    r.result = buildBaseResult(r, 'CAUGHT', submittedAt, { claimId: claim.claimId, chaseMs, confirmedAt: now, claimTeam: claim.seekerTeam }, now);
    events.unshift(ev('CLAIM_CONFIRMED', now, r.id, uid, { claimId: claim.claimId, team: claim.seekerTeam, foundAfterSeconds: Math.round(chaseMs / 1000) }));
    return {
      round: r,
      events,
      notifications: [notify(r, roundUids(r), 'CLAIM_CONFIRMED', 'Catch confirmed', `Official chase time ${fmtClock(chaseMs / 1000)}.`)],
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
        roundUids(r),
        type,
        status === 'REJECTED' ? 'Claim rejected' : 'Claim expired',
        status === 'REJECTED' ? 'Round resumed — the clock is running again.' : 'No decision in time — round resumed.',
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

/** The crew and side a phone plays for in this round, or a 403. */
function playerOf(round: RoundDoc, uid: string, action: string) {
  const team = snapshotTeamOf(round, uid);
  const role = roleOfTeam(round, team);
  if (!team || !role) fail('OPERATOR_NOT_AUTHORIZED', `Only phones in this round can ${action}`);
  return { team: team!, side: sideOfRole(role!) };
}

/**
 * Pause handling (spec §3.2). SAFETY pauses are immediate from any phone in
 * the round. A MANUAL pause is proposed by one side (hiders or seekers) and
 * starts when any phone on the other side accepts — two seeking crews can't
 * freeze the hiders on their own.
 */
export function requestPause(round: RoundDoc, uid: string, kind: 'MANUAL' | 'SAFETY', reason: string | null, now: number): Transition {
  const { team, side } = playerOf(round, uid, 'pause');
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
      notifications: [notify(r, roundUids(r), 'SAFETY_PAUSE', 'SAFETY PAUSE', `${name(r, team)} paused the round${reason ? `: ${reason}` : ''}. Clock and pings are frozen.`)],
    };
  }
  if (!r.rules.manualPausesEnabled) fail('FORBIDDEN', 'Manual pauses are disabled for this round');
  const pending = r.pendingPauseRequest && r.pendingPauseRequest.expiresAt > now ? r.pendingPauseRequest : null;
  if (pending && pending.bySide !== side) {
    startPause(r, 'MANUAL', pending.byUid, uid, pending.reason, now);
    return {
      round: r,
      events: [ev('PAUSE_STARTED', now, r.id, uid, { kind, team, reason: pending.reason })],
      notifications: [notify(r, roundUids(r), 'PAUSED', 'Round paused', 'Clock and pings are frozen.')],
    };
  }
  r.pendingPauseRequest = { id: `pr-${now}`, byUid: uid, byTeam: team, bySide: side, at: now, expiresAt: now + PAUSE_REQUEST_TTL_MS, reason };
  const otherSide = side === 'HIDERS' ? seekerUids(r) : hiderUids(r);
  return {
    round: withWake(r),
    events: [ev('PAUSE_REQUESTED', now, r.id, uid, { team, reason })],
    notifications: [notify(r, otherSide, 'PAUSE_REQUESTED', 'Pause requested', `${name(r, team)} asked to pause. Confirm in the app.`)],
  };
}

/** One vote from the hiders and one from the seekers ends a pause. */
export function voteResume(round: RoundDoc, uid: string, now: number): Transition {
  if (round.state !== 'PAUSED') fail('STALE_PHASE', 'Round is not paused');
  const { team, side } = playerOf(round, uid, 'resume');
  const r = clone(round);
  r.resumeVotes[side] = now;
  r.updatedAt = now;
  r.version++;
  if (!(r.resumeVotes.HIDERS && r.resumeVotes.SEEKERS)) {
    const otherSide = side === 'HIDERS' ? seekerUids(r) : hiderUids(r);
    return {
      round: r,
      events: [ev('RESUME_VOTE', now, r.id, uid, { team, side })],
      notifications: [notify(r, otherSide, 'RESUME_VOTE', 'Ready to resume?', `${name(r, team)} ${verb(r, [team], 'is', 'are')} ready. Tap Resume when your crew is.`)],
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
    notifications: [notify(r, roundUids(r), 'RESUMED', 'Round resumed', 'The clock is running again.')],
  };
}

export function abortRound(round: RoundDoc, uid: string | null, reason: string, now: number): Transition {
  if (!isActiveState(round.state)) fail('STALE_PHASE', 'Only an active round can be aborted');
  if (uid !== null && !roundUids(round).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only phones in this round can abort it');
  const r = clone(round);
  const events: DomainEvent[] = [];
  r.state = 'ABORTED';
  r.endedAt = now;
  endRound(r, now, events);
  r.abortedReason = reason;
  r.abortedByUid = uid;
  r.activeClaimId = null;
  r.claimExpiresAt = null;
  r.result = buildBaseResult(r, 'ABORTED', now, null, now);
  events.unshift(ev('ROUND_ABORTED', now, r.id, uid, { reason }));
  return {
    round: r,
    events,
    notifications: [notify(r, roundUids(r), 'ROUND_ABORTED', `Round ${r.index} aborted`, reason)],
  };
}

/**
 * Drop one phone from a round's snapshot (consent withdrawn mid-round). The
 * round continues on the crew's other phones; it aborts only if the crew has
 * no phone left.
 */
export function removePhoneFromRound(round: RoundDoc, uid: string, reason: string, now: number): Transition {
  const team = snapshotTeamOf(round, uid);
  if (!team) return { round, events: [], notifications: [] };
  if (isActiveState(round.state) && (round.operatorsByTeam[team] ?? []).length <= 1) return abortRound(round, null, reason, now);
  const r = clone(round);
  r.operatorsByTeam[team] = (r.operatorsByTeam[team] ?? []).filter((u) => u !== uid);
  r.updatedAt = now;
  r.version++;
  return { round: r, events: [ev('OPERATOR_REMOVED', now, r.id, uid, { team, reason })], notifications: [] };
}

export function buildBaseResult(
  r: RoundDoc,
  outcome: RoundOutcome,
  endAt: number,
  catchInfo: { claimId: string; chaseMs: number; confirmedAt: number; claimTeam: TeamKey } | null,
  now: number,
): RoundResult {
  const headStartSeconds = Math.round(effectiveHeadStartMs(r, endAt) / 1000);
  let observedChaseSeconds = 0;
  if (outcome === 'CAUGHT' && catchInfo) observedChaseSeconds = Math.round(catchInfo.chaseMs / 1000);
  else if (outcome === 'TIMED_OUT') observedChaseSeconds = r.rules.maxChaseSeconds ?? Math.round(effectiveChaseMs(r, endAt) / 1000);
  else observedChaseSeconds = Math.round(effectiveChaseMs(r, endAt) / 1000);
  const crews: RoundResult['crews'] = {};
  for (const k of roundTeams(r)) {
    crews[k] = {
      role: k === r.hidingTeam ? 'HIDING' : 'SEEKING',
      distanceTotalMeters: null,
      distanceChaseMeters: null,
      gpsCoverageFraction: null,
      routeQuality: 'INSUFFICIENT',
      phones: r.operatorsByTeam[k]?.length ?? 0,
    };
  }
  return {
    roundId: r.id,
    roundIndex: r.index,
    hidingTeam: r.hidingTeam,
    seekingTeams: [...r.seekingTeams],
    seekMode: r.seekMode,
    teamNames: { ...r.teamNames },
    rosterSnapshot: structuredClone(r.rosterSnapshot),
    catchCreditTeams: outcome === 'CAUGHT' && catchInfo ? catchCredit(r, catchInfo.claimTeam) : [],
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
    crews,
    rulesFingerprint: rulesFingerprint(r.rules, r.seekingTeams.length, r.seekMode),
    abortedReason: r.abortedReason,
    resolvedByDispute: false,
    finalizedAt: now,
  };
}

/** Brief of a finished round for the session document (no coordinates). */
export function roundBrief(r: RoundDoc, hidingRosterFingerprint: string): RoundBrief | null {
  if (!r.result) return null;
  return {
    roundId: r.id,
    index: r.index,
    hidingTeam: r.hidingTeam,
    seekingTeams: [...r.seekingTeams],
    seekMode: r.seekMode,
    catchCreditTeams: [...r.result.catchCreditTeams],
    outcome: r.result.outcome,
    observedChaseSeconds: r.result.observedChaseSeconds,
    isRightCensored: r.result.isRightCensored,
    rulesFingerprint: r.result.rulesFingerprint,
    hidingRosterFingerprint,
    teamNames: { ...r.teamNames },
  };
}

/**
 * Post-game dispute resolution: the hiding crew and the claimant's crew must
 * propose the same outcome. Another seeking crew neither votes nor blocks.
 */
export function proposeDisputeResolution(
  round: RoundDoc,
  claim: CaptureClaim,
  uid: string,
  resolution: 'ACCEPT_AS_CATCH' | 'KEEP_REJECTED',
  now: number,
): { round: RoundDoc; claim: CaptureClaim; events: DomainEvent[]; resolved: boolean } {
  if (isActiveState(round.state) || round.state === 'READY') fail('STALE_PHASE', 'Disputes can be closed only after the round');
  const team = snapshotTeamOf(round, uid);
  const parties = [round.hidingTeam, claim.seekerTeam];
  if (!team || !parties.includes(team)) fail('OPERATOR_NOT_AUTHORIZED', 'Only the hiding crew and the claiming crew can settle this claim');
  if (claim.status !== 'REJECTED' && claim.status !== 'EXPIRED') fail('CONFLICT', 'Only rejected or expired claims can be disputed');
  if (claim.dispute?.resolvedAt) fail('CONFLICT', 'Dispute already resolved');
  const c = structuredClone(claim);
  const r = clone(round);
  c.dispute = c.dispute ?? { proposals: {}, resolvedAt: null, resolution: null };
  c.dispute.proposals[team!] = { resolution, at: now, uid };
  const events: DomainEvent[] = [ev('DISPUTE_PROPOSED', now, r.id, uid, { claimId: c.claimId, resolution, team })];
  const hiders = c.dispute.proposals[round.hidingTeam]?.resolution;
  const claimants = c.dispute.proposals[claim.seekerTeam]?.resolution;
  let resolved = false;
  if (hiders && claimants && hiders === claimants) {
    c.dispute.resolvedAt = now;
    c.dispute.resolution = hiders;
    resolved = true;
    events.push(ev('DISPUTE_RESOLVED', now, r.id, uid, { claimId: c.claimId, resolution: hiders }));
    if (hiders === 'ACCEPT_AS_CATCH' && r.result && c.submittedAt !== null && c.officialChaseMsAtClaim !== null) {
      const earlier = r.result.outcome !== 'CAUGHT' || (r.result.officialFoundAt ?? Infinity) > c.submittedAt;
      if (earlier) {
        r.result = {
          ...r.result,
          outcome: 'CAUGHT',
          observedChaseSeconds: Math.round(c.officialChaseMsAtClaim / 1000),
          isRightCensored: false,
          officialFoundAt: c.submittedAt,
          claimId: c.claimId,
          catchCreditTeams: catchCredit(r, claim.seekerTeam),
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

/** A phone in a running round that hasn't reported since the start for this long is nudged. */
export const TRACKING_NUDGE_AFTER_MS = 60_000;
/** A phone that goes quiet mid-round (no report for this long) is nudged again. */
export const TRACKING_SILENT_MS = 5 * 60_000;
/** At most one nudge per phone this often. */
export const TRACKING_NUDGE_EVERY_MS = 10 * 60_000;

/**
 * "Your phone isn't tracking" pushes for phones in the round's snapshot that haven't
 * reported since the start, or went quiet. Tracking starts when the app sees the round
 * start, so a phone left in a pocket since the last round (or killed) records nothing
 * until someone opens it: on 2026-10-22 a hiding phone sent nothing for the first
 * 8½ minutes of a round. One push per phone per 10 minutes; never during a pause.
 */
export function trackingNudges(r: RoundDoc, members: Record<string, MemberDoc>, now: number): NotificationIntent[] {
  if ((r.state !== 'HEAD_START' && r.state !== 'CHASE') || hasOpenPause(r.pauses) || r.roundStartAt === null) return [];
  const out: NotificationIntent[] = [];
  for (const uid of roundUids(r)) {
    const m = members[uid];
    if (!m?.active) continue;
    const last = m.health.lastHeartbeatAt;
    // A report from the start's own millisecond is the Ready check, not tracking.
    const reported = last !== null && last > r.roundStartAt;
    const quiet = reported ? now - last! >= TRACKING_SILENT_MS : now - r.roundStartAt >= TRACKING_NUDGE_AFTER_MS;
    if (!quiet) continue;
    if (m.trackingNudge?.roundId === r.id && now - m.trackingNudge.at < TRACKING_NUDGE_EVERY_MS) continue;
    const hiding = r.operatorsByTeam[r.hidingTeam]?.includes(uid);
    out.push(
      notify(
        r,
        [uid],
        'TRACKING_NUDGE',
        'Your phone isn’t tracking',
        `Round ${r.index} is on. Open Manhunt Crews so ${hiding ? 'your crew’s pings can go out' : 'your crew’s route counts'}.`,
      ),
    );
  }
  return out;
}
