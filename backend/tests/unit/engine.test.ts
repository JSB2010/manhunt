import { describe, expect, it } from 'vitest';
import {
  abortRound,
  createRound,
  decideClaim,
  nextScheduledEvent,
  proposeDisputeResolution,
  requestPause,
  setReady,
  startRound,
  submitClaim,
  suggestedHidingTeam,
  voteResume,
} from '../../src/domain/engine.js';
import { AppError } from '../../src/domain/errors.js';
import { tickRound } from '../../src/domain/tick.js';
import type { CaptureClaim, GpsPoint, RoundDoc } from '../../src/domain/types.js';
import { claim, HIDER, MIN, point, readyRound, SEEKER, session, T0 } from './fixtures.js';

const tick = (round: RoundDoc, now: number, samples: GpsPoint[] = [], activeClaim: CaptureClaim | null = null) =>
  tickRound(round, now, { candidatesForDeadline: async () => samples, activeClaim });

function started(rules = {}) {
  const { session: s, round } = readyRound(rules);
  return { s, round: startRound(round, s, HIDER, [], T0).round };
}

/** Hider samples every 10 s from T0 to `until`, uploaded 3 s after recording. */
function hiderTrack(until: number): GpsPoint[] {
  const pts: GpsPoint[] = [];
  for (let t = T0; t <= until; t += 10_000) pts.push(point({ recordedAt: t, receivedAt: t + 3000 }));
  return pts;
}

describe('round lifecycle (spec §3.4 example)', () => {
  it('starts head start at server time, first ping at chase start, then every interval', async () => {
    const { round } = started();
    expect(round.state).toBe('HEAD_START');
    expect(round.roundStartAt).toBe(T0);
    expect(nextScheduledEvent(round)).toEqual({ kind: 'CHASE_START', at: T0 + 10 * MIN });

    const samples = hiderTrack(T0 + 60 * MIN);
    // 9:59 into head start nothing happens
    let r = (await tick(round, T0 + 10 * MIN - 1, samples)).round;
    expect(r.state).toBe('HEAD_START');
    expect(r.pings).toHaveLength(0);

    // exactly at 8:10 — chase starts AND first ping releases
    r = (await tick(r, T0 + 10 * MIN, samples)).round;
    expect(r.state).toBe('CHASE');
    expect(r.chaseStartAt).toBe(T0 + 10 * MIN);
    expect(r.pings).toHaveLength(1);
    expect(r.pings[0]).toMatchObject({ index: 0, scheduledAt: T0 + 10 * MIN, status: 'RELEASED' });
    expect(nextScheduledEvent(r)).toEqual({ kind: 'PING', at: T0 + 20 * MIN, pingIndex: 1 });

    r = (await tick(r, T0 + 30 * MIN, samples)).round;
    expect(r.pings.map((p) => p.scheduledAt)).toEqual([T0 + 10 * MIN, T0 + 20 * MIN, T0 + 30 * MIN]);

    // photo at 8:36, confirmed at 8:38 → official chase time 26:00
    const c = claim({ submittedAt: null });
    const sub = submitClaim(r, c, SEEKER, T0 + 36 * MIN);
    expect(sub.round.state).toBe('CAPTURE_PENDING');
    const pending = { ...c, status: 'PENDING' as const, submittedAt: T0 + 36 * MIN };
    // no ping releases while pending, even past 8:40
    const during = await tick(sub.round, T0 + 37 * MIN, samples, pending);
    expect(during.round.pings).toHaveLength(3);
    const done = decideClaim(during.round, pending, HIDER, 'CONFIRM', null, T0 + 38 * MIN);
    expect(done.round.state).toBe('COMPLETED');
    expect(done.round.result).toMatchObject({ outcome: 'CAUGHT', observedChaseSeconds: 26 * 60, officialFoundAt: T0 + 36 * MIN, headStartSeconds: 600, isRightCensored: false });
    expect(done.round.result!.confirmedAt).toBe(T0 + 38 * MIN);
  });

  it('head start of 0 starts the chase and first ping immediately', async () => {
    const { round } = started({ headStartSeconds: 0 });
    const r = (await tick(round, T0, [point({ recordedAt: T0 - 1000, receivedAt: T0 - 500 })])).round;
    expect(r.state).toBe('CHASE');
    expect(r.pings[0]!.scheduledAt).toBe(T0);
  });

  it('is idempotent under repeated ticks (Cloud Tasks retries)', async () => {
    const { round } = started();
    const samples = hiderTrack(T0 + 30 * MIN);
    const a = (await tick(round, T0 + 20 * MIN, samples)).round;
    const b = (await tick(a, T0 + 20 * MIN, samples)).round;
    const c = (await tick(b, T0 + 20 * MIN + 5000, samples)).round;
    expect(c.pings).toHaveLength(2);
    expect(new Set(c.pings.map((p) => p.index)).size).toBe(2);
  });

  it('catches up late but selects samples by deadline, and flags delayed dispatch', async () => {
    const { round } = started();
    const samples = hiderTrack(T0 + 40 * MIN);
    const r = (await tick(round, T0 + 25 * MIN, samples)).round;
    expect(r.pings).toHaveLength(2);
    const p1 = r.pings[1]!;
    expect(p1.scheduledAt).toBe(T0 + 20 * MIN);
    expect(p1.delayed).toBe(true);
    expect(p1.observedAt!).toBeLessThanOrEqual(T0 + 20 * MIN);
  });

  it('rejects round start without both ready operators, distinct accounts, or by non-host', () => {
    const { session: s, round } = readyRound();
    expect(() => startRound(round, s, SEEKER, [], T0)).toThrow(AppError);
    const notReady = { ...round, ready: { A: round.ready.A, B: null } };
    expect(() => startRound(notReady, s, HIDER, [], T0)).toThrow(/Ready/);
    const same = { ...s, teams: { ...s.teams, B: { ...s.teams.B, operatorUid: HIDER } } };
    expect(() => startRound(round, same, HIDER, [], T0)).toThrow(/distinct/);
  });

  it('ready marks invalidate if a different operator recorded them', () => {
    const { session: s, round } = readyRound();
    const r = setReady(round, 'B', 'someone-else', true, T0).round;
    expect(() => startRound(r, s, HIDER, [], T0)).toThrow(/re-confirm/);
  });
});

describe('capture claims', () => {
  async function inChase(atMin = 20) {
    const { round } = started();
    return (await tick(round, T0 + atMin * MIN, hiderTrack(T0 + atMin * MIN))).round;
  }

  it('only the seeker may submit, only during CHASE, only with stored photo', async () => {
    const r = await inChase();
    expect(() => submitClaim(r, claim({ seekerUid: HIDER }), HIDER, T0 + 21 * MIN)).toThrow(/seeking operator/);
    expect(() => submitClaim(r, claim({ photoStoredAt: null }), SEEKER, T0 + 21 * MIN)).toThrow(/Photo/);
    const { round: hs } = started();
    expect(() => submitClaim(hs, claim(), SEEKER, T0 + MIN)).toThrow(/during the chase/);
  });

  it('rejection resumes the clock from the frozen value and shifts future pings', async () => {
    const r = await inChase(22); // pings at 10, 20 released; next at 30
    const sub = submitClaim(r, claim(), SEEKER, T0 + 25 * MIN).round;
    const pending = claim({ status: 'PENDING', submittedAt: T0 + 25 * MIN, officialChaseMsAtClaim: 15 * MIN });
    expect(() => decideClaim(sub, pending, SEEKER, 'REJECT', null, T0 + 26 * MIN)).toThrow(/hiding operator/);
    const rej = decideClaim(sub, pending, HIDER, 'REJECT', 'Not us', T0 + 27 * MIN).round;
    expect(rej.state).toBe('CHASE');
    // 2 min pending excluded → next ping at 8:32 instead of 8:30
    expect(nextScheduledEvent(rej)).toEqual({ kind: 'PING', at: T0 + 32 * MIN, pingIndex: 2 });
    expect(rej.lastClaimOutcome).toMatchObject({ status: 'REJECTED', reason: 'Not us' });
  });

  it('does not reveal positions recorded during the pending interval', async () => {
    const r = await inChase(22);
    const sub = submitClaim(r, claim(), SEEKER, T0 + 29 * MIN + 30_000).round;
    const pending = claim({ status: 'PENDING', submittedAt: T0 + 29 * MIN + 30_000 });
    // reject 1 minute later; the remaining 30 s of interval fall due at 8:31:00
    const rej = decideClaim(sub, pending, HIDER, 'REJECT', null, T0 + 30 * MIN + 30_000).round;
    expect(nextScheduledEvent(rej)!.at).toBe(T0 + 31 * MIN);
    // the only samples in the 60 s window are from the pending interval → missing ping
    const pendingSamples = [point({ recordedAt: T0 + 30 * MIN, receivedAt: T0 + 30 * MIN + 2000 })];
    const after = (await tick(rej, T0 + 31 * MIN, pendingSamples)).round;
    expect(after.pings[2]).toMatchObject({ status: 'NO_FRESH_FIX', latitude: null, longitude: null });
  });

  it('expires to CHASE when the hider does not respond, never force-confirmed', async () => {
    const r = await inChase();
    const sub = submitClaim(r, claim(), SEEKER, T0 + 21 * MIN).round;
    const pending = claim({ status: 'PENDING', submittedAt: T0 + 21 * MIN });
    const exp = await tick(sub, T0 + 21 * MIN + 121_000, [], pending);
    expect(exp.round.state).toBe('CHASE');
    expect(exp.claimExpired?.claimId).toBe('claim1');
    expect(exp.round.lastClaimOutcome!.status).toBe('EXPIRED');
    expect(() => decideClaim(exp.round, pending, HIDER, 'CONFIRM', null, T0 + 23 * MIN)).toThrow();
  });

  it('second claim while pending is rejected; same claim replay is idempotent', async () => {
    const r = await inChase();
    const sub = submitClaim(r, claim(), SEEKER, T0 + 21 * MIN).round;
    expect(submitClaim(sub, claim(), SEEKER, T0 + 21 * MIN + 5).round).toBe(sub);
    expect(() => submitClaim(sub, claim({ claimId: 'claim2' }), SEEKER, T0 + 21 * MIN + 5)).toThrow(/awaiting/);
  });
});

describe('pauses', () => {
  it('manual pause needs both operators; resume needs both votes; schedule shifts', async () => {
    const { round } = started();
    const r0 = (await tick(round, T0 + 12 * MIN, hiderTrack(T0 + 12 * MIN))).round;
    const req = requestPause(r0, SEEKER, 'B', 'MANUAL', 'gas', T0 + 12 * MIN).round;
    expect(req.state).toBe('CHASE');
    expect(req.pendingPauseRequest?.byTeam).toBe('B');
    // same team cannot self-confirm
    expect(requestPause(req, SEEKER, 'B', 'MANUAL', 'gas', T0 + 12 * MIN + 1000).round.state).toBe('CHASE');
    const paused = requestPause(req, HIDER, 'A', 'MANUAL', null, T0 + 13 * MIN).round;
    expect(paused.state).toBe('PAUSED');
    expect(nextScheduledEvent(paused)).toBeNull();
    const v1 = voteResume(paused, HIDER, 'A', T0 + 15 * MIN).round;
    expect(v1.state).toBe('PAUSED');
    const resumed = voteResume(v1, SEEKER, 'B', T0 + 18 * MIN).round;
    expect(resumed.state).toBe('CHASE');
    expect(nextScheduledEvent(resumed)).toEqual({ kind: 'PING', at: T0 + 25 * MIN, pingIndex: 1 });
  });

  it('safety pause is immediate from either operator and freezes head start', async () => {
    const { round } = started();
    const p = requestPause(round, SEEKER, 'B', 'SAFETY', 'car trouble', T0 + 4 * MIN).round;
    expect(p.state).toBe('PAUSED');
    const res = voteResume(voteResume(p, HIDER, 'A', T0 + 6 * MIN).round, SEEKER, 'B', T0 + 7 * MIN).round;
    expect(res.state).toBe('HEAD_START');
    expect(nextScheduledEvent(res)).toEqual({ kind: 'CHASE_START', at: T0 + 13 * MIN });
    const ch = (await tick(res, T0 + 13 * MIN, hiderTrack(T0 + 13 * MIN))).round;
    expect(ch.chaseStartAt).toBe(T0 + 13 * MIN);
    expect(ch.pings[0]!.scheduledAt).toBe(T0 + 13 * MIN);
  });
});

describe('timeouts, aborts and role alternation', () => {
  it('time cap marks round TIMED_OUT and right-censored at the cap', async () => {
    const { round } = started({ maxChaseSeconds: 30 * 60 });
    const r = (await tick(round, T0 + 45 * MIN, hiderTrack(T0 + 45 * MIN))).round;
    expect(r.state).toBe('TIMED_OUT');
    expect(r.endedAt).toBe(T0 + 40 * MIN);
    expect(r.result).toMatchObject({ outcome: 'TIMED_OUT', observedChaseSeconds: 1800, isRightCensored: true });
    // ping at the same instant as the cap is not released
    expect(r.pings.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('abort records reason and closes the round', () => {
    const { round } = started();
    const a = abortRound(round, SEEKER, 'Rain', T0 + 5 * MIN).round;
    expect(a.state).toBe('ABORTED');
    expect(a.result!.outcome).toBe('ABORTED');
    expect(() => abortRound(round, 'stranger', 'x', T0)).toThrow(/operators/);
  });

  it('alternates roles by default and records host overrides', () => {
    const s = session();
    expect(suggestedHidingTeam(s.rules, 1, null)).toBe('A');
    expect(suggestedHidingTeam(s.rules, 2, 'A')).toBe('B');
    expect(suggestedHidingTeam({ ...s.rules, alternateRoles: false }, 2, 'A')).toBe('A');
    const t = createRound({ id: 'r2', session: s, index: 2, hidingTeam: 'A', suggestedHidingTeam: 'B', overrideByUid: HIDER, overrideReason: 'Crew B is injured', now: T0 });
    expect(t.round.roleOverride).toMatchObject({ suggestedHidingTeam: 'B', reason: 'Crew B is injured' });
    expect(t.events.map((e) => e.type)).toContain('ROLE_OVERRIDE');
  });
});

describe('post-game disputes', () => {
  it('requires both crews to agree before rewriting the outcome', async () => {
    const { round } = started({ maxChaseSeconds: 30 * 60 });
    const r = (await tick(round, T0 + 41 * MIN, hiderTrack(T0 + 41 * MIN))).round;
    const rejected = claim({ status: 'REJECTED', submittedAt: T0 + 30 * MIN, officialChaseMsAtClaim: 20 * MIN });
    const one = proposeDisputeResolution(r, rejected, HIDER, 'A', 'ACCEPT_AS_CATCH', T0 + 50 * MIN);
    expect(one.resolved).toBe(false);
    expect(one.round.result!.outcome).toBe('TIMED_OUT');
    const two = proposeDisputeResolution(one.round, one.claim, SEEKER, 'B', 'ACCEPT_AS_CATCH', T0 + 51 * MIN);
    expect(two.resolved).toBe(true);
    expect(two.round.result).toMatchObject({ outcome: 'CAUGHT', observedChaseSeconds: 1200, resolvedByDispute: true, isRightCensored: false });
  });
});
