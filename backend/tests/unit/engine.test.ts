import { describe, expect, it } from 'vitest';
import {
  abortRound,
  createRound,
  decideClaim,
  nextScheduledEvent,
  proposeDisputeResolution,
  refreshReadyRound,
  removePhoneFromRound,
  requestPause,
  roundBrief,
  setReady,
  startRound,
  submitClaim,
  suggestedHidingTeam,
  voteResume,
} from '../../src/domain/engine.js';
import { AppError } from '../../src/domain/errors.js';
import { tickRound } from '../../src/domain/tick.js';
import type { CaptureClaim, GpsPoint, RoundDoc, Rules, SessionDoc } from '../../src/domain/types.js';
import { allPhones, claim, HIDER, HIDER2, MIN, point, readyRound, SEEKER, SEEKER2, SEEKER_C, session, T0, type NightOpts } from './fixtures.js';

const tick = (round: RoundDoc, now: number, samples: GpsPoint[] = [], activeClaim: CaptureClaim | null = null) =>
  tickRound(round, now, { hiderSamples: async (from, to) => samples.filter((x) => x.recordedAt >= from && x.recordedAt <= to), activeClaim });

function started(rules: Partial<Rules> = {}, opts: Parameters<typeof readyRound>[1] = {}) {
  const { session: s, round } = readyRound(rules, opts);
  return { s, round: startRound(round, s, HIDER, allPhones(s), [], T0).round };
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
    const r = (await tick(round, T0, [point({ recordedAt: T0, receivedAt: T0 })])).round;
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

  it('rejects start until every crew is ready, and by phones outside the playing crews', () => {
    const { session: s, round } = readyRound();
    expect(() => startRound(round, s, 'stranger', allPhones(s), [], T0)).toThrow(/operator/);
    const notReady = { ...round, ready: { A: round.ready.A, B: null } };
    expect(() => startRound(notReady, s, HIDER, allPhones(s), [], T0)).toThrow(/Ready/);
    // the seeking crew may start too — there is no lead phone
    expect(startRound(round, s, SEEKER, allPhones(s), [], T0).round.state).toBe('HEAD_START');
  });

  it('a crew needs an eligible phone, and its ready mark must come from one', () => {
    const { session: s, round } = readyRound();
    expect(() => startRound(round, s, HIDER, new Set([HIDER]), [], T0)).toThrow(/needs? a phone in the game/);
    const r = setReady(round, 'B', 'someone-else', true, T0).round;
    expect(() => startRound(r, s, HIDER, allPhones(s), [], T0)).toThrow(/Ready again/);
  });

  it('snapshots every eligible phone per crew at start', () => {
    const { session: s, round } = readyRound({}, { phonesA: [HIDER, HIDER2], phonesB: [SEEKER, SEEKER2] });
    const r = startRound(round, s, SEEKER2, new Set([HIDER, HIDER2, SEEKER]), [], T0).round;
    expect(r.operatorsByTeam).toEqual({ A: [HIDER, HIDER2], B: [SEEKER] });
  });
});

describe('several phones per crew', () => {
  const two: NightOpts = { phonesA: [HIDER, HIDER2], phonesB: [SEEKER, SEEKER2] };

  it('takes the freshest fix across hider phones for a ping', async () => {
    const { round } = started({}, two);
    const a = point({ operatorUid: HIDER, recordedAt: T0 + 10 * MIN - 40_000 });
    const b = point({ operatorUid: HIDER2, recordedAt: T0 + 10 * MIN - 5_000, receivedAt: T0 + 10 * MIN - 3_000 });
    const r = (await tick(round, T0 + 10 * MIN, [a, b])).round;
    expect(r.pings[0]).toMatchObject({ status: 'RELEASED', sourcePointId: b.pointId, sourceUid: HIDER2 });
  });

  it('any phone of the crew acts: a second seeker claims, a second hider decides', async () => {
    const { round } = started({}, two);
    const r = (await tick(round, T0 + 20 * MIN, [point({ recordedAt: T0 + 20 * MIN - 5000 })])).round;
    const c = claim({ seekerUid: SEEKER2 });
    const sub = submitClaim(r, c, SEEKER2, T0 + 21 * MIN).round;
    const pending = { ...c, status: 'PENDING' as const, submittedAt: T0 + 21 * MIN };
    const done = decideClaim(sub, pending, HIDER2, 'CONFIRM', null, T0 + 22 * MIN).round;
    expect(done.state).toBe('COMPLETED');
    // a concurrent decision by the other hider phone loses cleanly
    expect(() => decideClaim(done, pending, HIDER, 'REJECT', null, T0 + 22 * MIN)).toThrow(/already decided/);
  });

  it('a phone that joined after the start is a spectator for the round', async () => {
    const { round } = started({}, two);
    const r = (await tick(round, T0 + 20 * MIN, [point({ recordedAt: T0 + 20 * MIN - 5000 })])).round;
    expect(() => submitClaim(r, claim({ seekerUid: 'late-phone' }), 'late-phone', T0 + 21 * MIN)).toThrow(/seeking crew/);
    expect(() => requestPause(r, 'late-phone', 'SAFETY', null, T0 + 21 * MIN)).toThrow(/phones in this round/);
  });

  it('dropping a phone keeps the round going until its crew has none left', () => {
    const { round } = started({}, two);
    const one = removePhoneFromRound(round, HIDER2, 'consent withdrawn', T0 + MIN);
    expect(one.round.state).toBe('HEAD_START');
    expect(one.round.operatorsByTeam.A).toEqual([HIDER]);
    const none = removePhoneFromRound(one.round, HIDER, 'consent withdrawn', T0 + 2 * MIN);
    expect(none.round.state).toBe('ABORTED');
  });
});

describe('waiting pings (ADR 0015)', () => {
  it('waits when no hider fix reached the server, then releases the current position', async () => {
    const { round } = started();
    // hider offline from 8:05; nothing for the 8:10 deadline
    const before = [point({ recordedAt: T0 + 5 * MIN })];
    const waiting = await tick(round, T0 + 10 * MIN, before);
    expect(waiting.round.pings).toHaveLength(0);
    expect(waiting.round.waitingPing).toEqual({ index: 0, deadline: T0 + 10 * MIN, since: T0 + 10 * MIN });
    expect(waiting.events.map((e) => e.type)).toContain('PING_WAITING');
    expect(waiting.notifications.find((n) => n.kind === 'PING_WAITING')?.toUids).toEqual([HIDER]);

    // reconnect at 8:13 with a backlog from 8:06–8:13: only the current fix is released
    const backlog = [6, 8, 10, 12].map((m) => point({ recordedAt: T0 + m * MIN, receivedAt: T0 + 13 * MIN }));
    const now = point({ recordedAt: T0 + 13 * MIN - 2000, receivedAt: T0 + 13 * MIN });
    const late = await tick(waiting.round, T0 + 13 * MIN, [...before, ...backlog, now]);
    expect(late.round.waitingPing).toBeNull();
    expect(late.round.pings[0]).toMatchObject({ index: 0, status: 'RELEASED', delayed: true, sourcePointId: now.pointId });
    expect(late.processed.map((x) => x.kind)).toContain('LATE_PING');
  });

  it('a waiting ping is superseded by the next deadline and closed as missing', async () => {
    const { round } = started();
    const r = (await tick(round, T0 + 20 * MIN, [])).round;
    expect(r.pings.map((p) => [p.index, p.status])).toEqual([[0, 'NO_FRESH_FIX']]);
    expect(r.waitingPing).toMatchObject({ index: 1, deadline: T0 + 20 * MIN });
  });

  it('closes a waiting ping as missing when the round ends', async () => {
    const { round } = started();
    const r = (await tick(round, T0 + 10 * MIN, [])).round;
    const a = abortRound(r, SEEKER, 'Rain', T0 + 11 * MIN).round;
    expect(a.waitingPing).toBeNull();
    expect(a.pings[0]).toMatchObject({ index: 0, status: 'NO_FRESH_FIX', latitude: null });
  });

  it('holds while paused and never releases a fix recorded during the pause', async () => {
    const { round } = started();
    const r = (await tick(round, T0 + 10 * MIN, [])).round;
    const paused = requestPause(r, SEEKER, 'SAFETY', null, T0 + 11 * MIN).round;
    const during = point({ recordedAt: T0 + 12 * MIN, receivedAt: T0 + 12 * MIN + 1000 });
    expect((await tick(paused, T0 + 12 * MIN + 2000, [during])).round.waitingPing).not.toBeNull();
    const resumed = voteResume(voteResume(paused, HIDER, T0 + 13 * MIN).round, SEEKER, T0 + 13 * MIN).round;
    const still = await tick(resumed, T0 + 13 * MIN + 1000, [during]);
    expect(still.round.waitingPing).not.toBeNull();
    const fresh = point({ recordedAt: T0 + 13 * MIN + 5000, receivedAt: T0 + 13 * MIN + 6000 });
    const out = await tick(still.round, T0 + 13 * MIN + 7000, [during, fresh]);
    expect(out.round.pings[0]).toMatchObject({ status: 'RELEASED', sourcePointId: fresh.pointId });
  });
});

describe('three crews', () => {
  const three: NightOpts = { three: true };

  it('one crew hides, both others seek; RACE credits the catching crew only', async () => {
    const { round } = started({}, { ...three, seekMode: 'RACE' });
    expect(round.seekingTeams).toEqual(['B', 'C']);
    const r = (await tick(round, T0 + 20 * MIN, [point({ recordedAt: T0 + 20 * MIN - 5000 })])).round;
    const c = claim({ seekerUid: SEEKER_C, seekerTeam: 'C' });
    const sub = submitClaim(r, c, SEEKER_C, T0 + 21 * MIN);
    expect(sub.notifications.find((n) => n.kind === 'CLAIM_SUBMITTED' && n.toUids.includes(SEEKER))).toBeTruthy();
    const done = decideClaim(sub.round, { ...c, status: 'PENDING', submittedAt: T0 + 21 * MIN }, HIDER, 'CONFIRM', null, T0 + 22 * MIN).round;
    expect(done.result!.catchCreditTeams).toEqual(['C']);
    expect(Object.keys(done.result!.crews).sort()).toEqual(['A', 'B', 'C']);
  });

  it('TOGETHER credits every seeking crew', async () => {
    const { round } = started({}, three);
    const r = (await tick(round, T0 + 20 * MIN, [point({ recordedAt: T0 + 20 * MIN - 5000 })])).round;
    const sub = submitClaim(r, claim(), SEEKER, T0 + 21 * MIN).round;
    const done = decideClaim(sub, claim({ status: 'PENDING', submittedAt: T0 + 21 * MIN }), HIDER, 'CONFIRM', null, T0 + 22 * MIN).round;
    expect(done.result!.catchCreditTeams).toEqual(['B', 'C']);
  });

  it('pauses are hiders vs seekers: another seeking crew cannot accept a seeker pause', async () => {
    const { round } = started({}, three);
    const req = requestPause(round, SEEKER, 'MANUAL', null, T0 + MIN).round;
    expect(req.pendingPauseRequest).toMatchObject({ byTeam: 'B', bySide: 'SEEKERS' });
    expect(requestPause(req, SEEKER_C, 'MANUAL', null, T0 + MIN + 1000).round.state).toBe('HEAD_START');
    const paused = requestPause(req, HIDER, 'MANUAL', null, T0 + 2 * MIN).round;
    expect(paused.state).toBe('PAUSED');
    // one hider vote and one seeker vote (either seeking crew) resume
    const v = voteResume(paused, SEEKER_C, T0 + 3 * MIN).round;
    expect(v.state).toBe('PAUSED');
    expect(voteResume(v, HIDER, T0 + 4 * MIN).round.state).toBe('HEAD_START');
  });

  it('disputes are settled by the hiding crew and the claiming crew', async () => {
    const { round } = started({ maxChaseSeconds: 30 * 60 }, { ...three, seekMode: 'RACE' });
    const r = (await tick(round, T0 + 41 * MIN, [])).round;
    const rejected = claim({ status: 'REJECTED', seekerUid: SEEKER_C, seekerTeam: 'C', submittedAt: T0 + 30 * MIN, officialChaseMsAtClaim: 20 * MIN });
    expect(() => proposeDisputeResolution(r, rejected, SEEKER, 'ACCEPT_AS_CATCH', T0 + 50 * MIN)).toThrow(/claiming crew/);
    const one = proposeDisputeResolution(r, rejected, HIDER, 'ACCEPT_AS_CATCH', T0 + 50 * MIN);
    const two = proposeDisputeResolution(one.round, one.claim, SEEKER_C, 'ACCEPT_AS_CATCH', T0 + 51 * MIN);
    expect(two.resolved).toBe(true);
    expect(two.round.result!.catchCreditTeams).toEqual(['C']);
  });
});

describe('capture claims', () => {
  async function inChase(atMin = 20) {
    const { round } = started();
    return (await tick(round, T0 + atMin * MIN, hiderTrack(T0 + atMin * MIN))).round;
  }

  it('only the seeker may submit, only during CHASE, only with stored photo', async () => {
    const r = await inChase();
    expect(() => submitClaim(r, claim({ seekerUid: HIDER }), HIDER, T0 + 21 * MIN)).toThrow(/seeking crew/);
    expect(() => submitClaim(r, claim({ photoStoredAt: null }), SEEKER, T0 + 21 * MIN)).toThrow(/Photo/);
    const { round: hs } = started();
    expect(() => submitClaim(hs, claim(), SEEKER, T0 + MIN)).toThrow(/during the chase/);
  });

  it('rejection resumes the clock from the frozen value and shifts future pings', async () => {
    const r = await inChase(22); // pings at 10, 20 released; next at 30
    const sub = submitClaim(r, claim(), SEEKER, T0 + 25 * MIN).round;
    const pending = claim({ status: 'PENDING', submittedAt: T0 + 25 * MIN, officialChaseMsAtClaim: 15 * MIN });
    expect(() => decideClaim(sub, pending, SEEKER, 'REJECT', null, T0 + 26 * MIN)).toThrow(/hiding crew/);
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
    // the only samples in the 60 s window are from the pending interval → the ping waits
    const pendingSamples = [point({ recordedAt: T0 + 30 * MIN, receivedAt: T0 + 30 * MIN + 2000 })];
    const after = (await tick(rej, T0 + 31 * MIN, pendingSamples)).round;
    expect(after.pings).toHaveLength(2);
    expect(after.waitingPing).toMatchObject({ index: 2, deadline: T0 + 31 * MIN });
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
  it('manual pause needs both sides; resume needs both votes; schedule shifts', async () => {
    const { round } = started();
    const r0 = (await tick(round, T0 + 12 * MIN, hiderTrack(T0 + 12 * MIN))).round;
    const req = requestPause(r0, SEEKER, 'MANUAL', 'gas', T0 + 12 * MIN).round;
    expect(req.state).toBe('CHASE');
    expect(req.pendingPauseRequest?.byTeam).toBe('B');
    // same side cannot self-confirm
    expect(requestPause(req, SEEKER, 'MANUAL', 'gas', T0 + 12 * MIN + 1000).round.state).toBe('CHASE');
    const paused = requestPause(req, HIDER, 'MANUAL', null, T0 + 13 * MIN).round;
    expect(paused.state).toBe('PAUSED');
    expect(nextScheduledEvent(paused)).toBeNull();
    const v1 = voteResume(paused, HIDER, T0 + 15 * MIN).round;
    expect(v1.state).toBe('PAUSED');
    const resumed = voteResume(v1, SEEKER, T0 + 18 * MIN).round;
    expect(resumed.state).toBe('CHASE');
    expect(nextScheduledEvent(resumed)).toEqual({ kind: 'PING', at: T0 + 25 * MIN, pingIndex: 1 });
  });

  it('safety pause is immediate from either operator and freezes head start', async () => {
    const { round } = started();
    const p = requestPause(round, SEEKER, 'SAFETY', 'car trouble', T0 + 4 * MIN).round;
    expect(p.state).toBe('PAUSED');
    const res = voteResume(voteResume(p, HIDER, T0 + 6 * MIN).round, SEEKER, T0 + 7 * MIN).round;
    expect(res.state).toBe('HEAD_START');
    expect(nextScheduledEvent(res)).toEqual({ kind: 'CHASE_START', at: T0 + 13 * MIN });
    const ch = (await tick(res, T0 + 13 * MIN, hiderTrack(T0 + 13 * MIN))).round;
    expect(ch.chaseStartAt).toBe(T0 + 13 * MIN);
    expect(ch.pings[0]!.scheduledAt).toBe(T0 + 13 * MIN);
  });
});

describe('timeouts, aborts and open-ended nights', () => {
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
    expect(() => abortRound(round, 'stranger', 'x', T0)).toThrow(/phones in this round/);
  });

  it('suggests the crew that has hidden least, ties to whoever hid longest ago', () => {
    const brief = (index: number, hidingTeam: 'A' | 'B' | 'C', outcome: 'CAUGHT' | 'ABORTED' = 'CAUGHT') => ({
      roundId: `r${index}`,
      index,
      hidingTeam,
      seekingTeams: [],
      seekMode: 'TOGETHER' as const,
      catchCreditTeams: [],
      outcome,
      observedChaseSeconds: 60,
      isRightCensored: false,
      rulesFingerprint: 'x',
      hidingRosterFingerprint: 'y',
    });
    const s = session({}, { three: true });
    expect(suggestedHidingTeam(s)).toBe('A');
    expect(suggestedHidingTeam({ ...s, roundBriefs: [brief(1, 'A')] } as SessionDoc)).toBe('B');
    expect(suggestedHidingTeam({ ...s, roundBriefs: [brief(1, 'B'), brief(2, 'C'), brief(3, 'A')] } as SessionDoc)).toBe('B');
    // aborted rounds don't count as a hide
    expect(suggestedHidingTeam({ ...s, roundBriefs: [brief(1, 'A', 'ABORTED')] } as SessionDoc)).toBe('A');
  });

  it('a READY round can be re-targeted to any crew; ready marks reset when roles change', () => {
    const { session: s, round } = readyRound({}, { three: true });
    const same = refreshReadyRound(round, s, T0, { seekMode: 'RACE' });
    expect(same.seekMode).toBe('RACE');
    expect(same.ready.A).toBeTruthy();
    const r = refreshReadyRound(round, s, T0, { hidingTeam: 'C' });
    expect(r.hidingTeam).toBe('C');
    expect(r.seekingTeams).toEqual(['A', 'B']);
    expect(r.ready).toEqual({});
  });

  it('keeps ready marks only for phones still on their crew', () => {
    const { session: s, round } = readyRound();
    const moved = { ...s, teams: { ...s.teams, B: { ...s.teams.B!, operatorUids: [SEEKER2] } } };
    const r = refreshReadyRound(round, moved, T0);
    expect(r.ready.A).toBeTruthy();
    expect(r.ready.B).toBeUndefined();
  });

  it('creates a round with every other crew seeking, and briefs carry the roster fingerprint', async () => {
    const s = session({}, { three: true });
    const t = createRound({ id: 'r2', session: s, index: 2, hidingTeam: 'B', seekMode: 'RACE', actorUid: SEEKER, now: T0 });
    expect(t.round.seekingTeams).toEqual(['A', 'C']);
    expect(t.notifications[0]!.toUids.sort()).toEqual([HIDER, SEEKER, SEEKER_C].sort());
    const { round } = started({ maxChaseSeconds: 30 * 60 });
    const done = (await tick(round, T0 + 45 * MIN, [])).round;
    expect(roundBrief(done, 'fp')).toMatchObject({ hidingTeam: 'A', seekingTeams: ['B'], outcome: 'TIMED_OUT', hidingRosterFingerprint: 'fp' });
  });
});

describe('post-game disputes', () => {
  it('requires both crews to agree before rewriting the outcome', async () => {
    const { round } = started({ maxChaseSeconds: 30 * 60 });
    const r = (await tick(round, T0 + 41 * MIN, hiderTrack(T0 + 41 * MIN))).round;
    const rejected = claim({ status: 'REJECTED', submittedAt: T0 + 30 * MIN, officialChaseMsAtClaim: 20 * MIN });
    const one = proposeDisputeResolution(r, rejected, HIDER, 'ACCEPT_AS_CATCH', T0 + 50 * MIN);
    expect(one.resolved).toBe(false);
    expect(one.round.result!.outcome).toBe('TIMED_OUT');
    const two = proposeDisputeResolution(one.round, one.claim, SEEKER, 'ACCEPT_AS_CATCH', T0 + 51 * MIN);
    expect(two.resolved).toBe(true);
    expect(two.round.result).toMatchObject({ outcome: 'CAUGHT', observedChaseSeconds: 1200, resolvedByDispute: true, isRightCensored: false });
  });
});
