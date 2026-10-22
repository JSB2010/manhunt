import { describe, expect, it } from 'vitest';
import { decideClaim, requestPause, startRound, submitClaim } from '../../src/domain/engine.js';
import { tickRound } from '../../src/domain/tick.js';
import type { GpsPoint, RoundDoc } from '../../src/domain/types.js';
import { liveActivityAttributes, liveActivityState, renderView } from '../../src/domain/views.js';
import { allPhones, claim, HIDER, HIDER2, members, MIN, point, readyRound, SEEKER, SEEKER2, SEEKER_C, T0 } from './fixtures.js';

/** Recursively collect every numeric value in an object. */
function numbers(o: unknown, out: number[] = []): number[] {
  if (typeof o === 'number') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => numbers(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => numbers(x, out));
  return out;
}

const tick = (r: RoundDoc, now: number, samples: GpsPoint[]) =>
  tickRound(r, now, { hiderSamples: async (from, to) => samples.filter((x) => x.recordedAt >= from && x.recordedAt <= to), activeClaim: null });

/** Hider walk with distinctive coordinates so any leak is detectable. */
function track(until: number, operatorUid = HIDER, offset = 0): GpsPoint[] {
  const pts: GpsPoint[] = [];
  let i = 0;
  for (let t = T0 + offset; t <= until; t += 7_000) {
    pts.push(point({ operatorUid, recordedAt: t, receivedAt: t + 2_000, latitude: 39.7 + i * 0.000123 + offset * 1e-9, longitude: -105.1 - i * 0.000321 }));
    i++;
  }
  return pts;
}

describe('per-user view privacy invariant', () => {
  it('seeker view contains only released pin coordinates in every active phase (host = seeker too)', async () => {
    const { session: s0, round: r0 } = readyRound({ visiblePingHistoryCount: 2 });
    // Make the SEEKER the host — the host gets no spying privilege.
    const s = { ...s0, hostUid: SEEKER };
    const all = track(T0 + 60 * MIN);
    let r: RoundDoc = startRound(r0, s, SEEKER, allPhones(s), [], T0).round;
    const sampleCoords = new Set(all.flatMap((p) => [p.latitude, p.longitude]));

    const check = (round: RoundDoc, now: number) => {
      const v = renderView({ uid: SEEKER, session: s, round, members: members(s), activeClaim: null, now });
      const released = new Set(round.pings.flatMap((p) => (p.status === 'RELEASED' ? [p.latitude!, p.longitude!] : [])));
      const leaked = numbers(v).filter((n) => sampleCoords.has(n) && !released.has(n));
      expect(leaked).toEqual([]);
      expect(v.round!.pins.length).toBeLessThanOrEqual(2);
      const serialized = JSON.stringify(v);
      for (const k of ['hiderRoute', 'latestHiderLocation', 'points', 'samples', 'track']) expect(serialized).not.toContain(`"${k}"`);
      return v;
    };

    check(r, T0 + 5 * MIN); // HEAD_START
    for (const m of [10, 15, 20, 25, 30, 41]) {
      r = (await tick(r, T0 + m * MIN, all)).round;
      check(r, T0 + m * MIN);
    }
    expect(r.pings.length).toBe(4);
    const v = check(r, T0 + 41 * MIN);
    // history count 2 → only the two most recent released pins
    expect(v.round!.pins.map((p) => p.index)).toEqual([2, 3]);

    const sub = submitClaim(r, claim(), SEEKER, T0 + 42 * MIN).round;
    check(sub, T0 + 43 * MIN);
  });

  it('hider view never includes the seeker position and only shows the capture request to the hider', async () => {
    const { session: s, round: r0 } = readyRound();
    let r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    r = (await tick(r, T0 + 12 * MIN, track(T0 + 12 * MIN))).round;
    const c = { ...claim(), status: 'PENDING' as const, submittedAt: T0 + 13 * MIN, officialChaseMsAtClaim: 3 * MIN };
    r = submitClaim(r, claim(), SEEKER, T0 + 13 * MIN).round;
    const hv = renderView({ uid: HIDER, session: s, round: r, members: members(s), activeClaim: c, now: T0 + 13 * MIN + 1000 });
    expect(hv.round!.myRole).toBe('HIDING');
    expect(hv.round!.captureRequest?.claimId).toBe('claim1');
    expect(hv.round!.captureRequest?.chaseSecondsAtClaim).toBe(180);
    const sv = renderView({ uid: SEEKER, session: s, round: r, members: members(s), activeClaim: c, now: T0 + 13 * MIN + 1000 });
    expect(sv.round!.captureRequest).toBeNull();
    expect(sv.round!.myClaim?.status).toBe('PENDING');
    // clocks freeze while pending
    expect(sv.round!.chaseClock).toEqual({ accumulatedMs: 3 * MIN, runningSince: null });
    const done = decideClaim(r, c, HIDER, 'CONFIRM', null, T0 + 14 * MIN).round;
    const after = renderView({ uid: SEEKER, session: s, round: done, members: members(s), activeClaim: null, now: T0 + 14 * MIN });
    expect(after.round!.result?.observedChaseSeconds).toBe(180);
  });

  it('crew status is coarse: counts and a state, no timestamps or positions', () => {
    const { session: s, round } = readyRound({}, { phonesA: [HIDER, HIDER2] });
    const m = members(s);
    m[HIDER]!.health.lastHeartbeatAt = T0 + 17_345;
    m[HIDER2]!.health.lastHeartbeatAt = T0 - 10 * MIN;
    const v = renderView({ uid: SEEKER, session: s, round, members: m, activeClaim: null, now: T0 + 20_000 });
    expect(v.round!.crewStatus.A).toEqual({ live: 1, total: 2, state: 'ACTIVE', issues: [] });
    expect(Object.keys(v.round!.crewStatus.A!).sort()).toEqual(['issues', 'live', 'state', 'total']);
  });

  it('a hider phone that has not reported since the start reads as starting, not stopped', () => {
    const { session: s, round: r0 } = readyRound();
    const m = members(s);
    // Its last report is the Ready check, sent before tracking began.
    m[HIDER]!.health = { ...m[HIDER]!.health, trackingActive: false, lastHeartbeatAt: T0 - 20_000 };
    const r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    const at = (now: number) => renderView({ uid: SEEKER, session: s, round: r, members: m, activeClaim: null, now }).round!.crewStatus.A!.state;
    expect(at(T0 + 1000)).toBe('STARTING');
    expect(at(T0 + 3 * MIN)).toBe('STALE');
    m[HIDER]!.health = { ...m[HIDER]!.health, trackingActive: false, lastHeartbeatAt: T0 + 30_000 };
    expect(at(T0 + 40_000)).toBe('STOPPED');
  });

  it('clock view lets clients compute elapsed from server timestamps', async () => {
    const { session: s, round: r0 } = readyRound();
    let r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    r = (await tick(r, T0 + 15 * MIN, track(T0 + 15 * MIN))).round;
    const v = renderView({ uid: SEEKER, session: s, round: r, members: members(s), activeClaim: null, now: T0 + 15 * MIN });
    const c = v.round!.chaseClock!;
    const elapsedAt = (now: number) => c.accumulatedMs + (now - Date.parse(c.runningSince!));
    expect(elapsedAt(T0 + 15 * MIN)).toBe(5 * MIN);
    expect(elapsedAt(T0 + 16 * MIN)).toBe(6 * MIN);
    expect(v.round!.nextPingAt).toBe(new Date(T0 + 20 * MIN).toISOString());
  });

  it('several hider phones: seekers get released pins only, never any phone\'s samples or the source phone', async () => {
    const { session: s, round: r0 } = readyRound({ visiblePingHistoryCount: null }, { phonesA: [HIDER, HIDER2], phonesB: [SEEKER, SEEKER2] });
    const all = [...track(T0 + 40 * MIN, HIDER), ...track(T0 + 40 * MIN, HIDER2, 3_000)];
    const sampleCoords = new Set(all.flatMap((p) => [p.latitude, p.longitude]));
    let r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    for (const m of [10, 20, 30]) r = (await tick(r, T0 + m * MIN, all)).round;
    r = { ...r, routeSourceUids: { A: HIDER2, B: SEEKER } };
    expect(r.pings.some((p) => p.sourceUid === HIDER2)).toBe(true);
    for (const uid of [SEEKER, SEEKER2]) {
      const v = renderView({ uid, session: s, round: r, members: members(s), activeClaim: null, now: T0 + 31 * MIN });
      const released = new Set(r.pings.flatMap((p) => [p.latitude!, p.longitude!]));
      expect(numbers(v).filter((n) => sampleCoords.has(n) && !released.has(n))).toEqual([]);
      const json = JSON.stringify(v);
      for (const k of ['sourceUid', 'sourcePointId', 'routeSourceUids', 'operatorsByTeam']) expect(json).not.toContain(`"${k}"`);
      // Phones are listed by crew for the night's members, but nothing in the round says which phone a pin came from.
      expect(JSON.stringify(v.round)).not.toContain(HIDER2);
    }
  });

  it('a waiting ping tells the round only its index and times — no coordinates', async () => {
    const { session: s, round: r0 } = readyRound();
    const r = (await tick(startRound(r0, s, HIDER, allPhones(s), [], T0).round, T0 + 10 * MIN, [point({ recordedAt: T0 + 5 * MIN, latitude: 39.123456, longitude: -105.654321 })])).round;
    const v = renderView({ uid: SEEKER, session: s, round: r, members: members(s), activeClaim: null, now: T0 + 11 * MIN });
    expect(v.round!.waitingPing).toEqual({ index: 0, deadline: new Date(T0 + 10 * MIN).toISOString(), since: new Date(T0 + 10 * MIN).toISOString() });
    expect(numbers(v)).not.toContain(39.123456);
    expect(v.round!.pins).toEqual([]);
  });

  it('a phone that joined after the start is a spectator: no pins, no claim, no ping log', async () => {
    const { session: s0, round: r0 } = readyRound();
    let r = startRound(r0, s0, HIDER, allPhones(s0), [], T0).round;
    r = (await tick(r, T0 + 20 * MIN, track(T0 + 20 * MIN))).round;
    const s = { ...s0, teams: { ...s0.teams, B: { ...s0.teams.B!, operatorUids: [SEEKER, 'late-phone'] } } };
    const v = renderView({ uid: 'late-phone', session: s, round: r, members: members(s), activeClaim: null, now: T0 + 21 * MIN });
    expect(v.round!.myRole).toBeNull();
    expect(v.round!.pins).toEqual([]);
    expect(v.round!.pingLog).toEqual([]);
    expect(numbers(v.round!.pins)).toEqual([]);
  });

  it('RACE: every hider phone reviews the claim; the other seeking crew sees who claimed but not the claim', async () => {
    const { session: s, round: r0 } = readyRound({}, { three: true, phonesA: [HIDER, HIDER2], seekMode: 'RACE' });
    let r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    r = (await tick(r, T0 + 12 * MIN, track(T0 + 12 * MIN))).round;
    const c = claim({ seekerUid: SEEKER_C, seekerTeam: 'C', status: 'PENDING', submittedAt: T0 + 13 * MIN, officialChaseMsAtClaim: 3 * MIN });
    r = submitClaim(r, claim({ seekerUid: SEEKER_C, seekerTeam: 'C' }), SEEKER_C, T0 + 13 * MIN).round;
    const at = T0 + 13 * MIN + 1000;
    for (const uid of [HIDER, HIDER2]) expect(renderView({ uid, session: s, round: r, members: members(s), activeClaim: c, now: at }).round!.captureRequest?.claimId).toBe('claim1');
    const other = renderView({ uid: SEEKER, session: s, round: r, members: members(s), activeClaim: c, now: at }).round!;
    expect(other.captureRequest).toBeNull();
    expect(other.myClaim).toBeNull();
    expect(other.claimByTeam).toBe('C');
    const mine = renderView({ uid: SEEKER_C, session: s, round: r, members: members(s), activeClaim: c, now: at }).round!;
    expect(mine.myClaim).toMatchObject({ status: 'PENDING', byMe: true });
  });

  it('Live Activity content (Lock Screen, Dynamic Island) carries no coordinates, phones, rosters or free text', async () => {
    const { session: s, round: r0 } = readyRound({ visiblePingHistoryCount: null }, { phonesA: [HIDER, HIDER2], phonesB: [SEEKER, SEEKER2] });
    const all = [...track(T0 + 40 * MIN, HIDER), ...track(T0 + 40 * MIN, HIDER2, 3_000)];
    const coords = new Set(all.flatMap((p) => [p.latitude, p.longitude]));
    let r = startRound(r0, s, HIDER, allPhones(s), [], T0).round;
    const rounds: [RoundDoc, number][] = [[r, T0 + MIN]];
    for (const m of [10, 20, 30]) {
      r = (await tick(r, T0 + m * MIN, all)).round;
      rounds.push([r, T0 + m * MIN + 1000]);
    }
    const c = claim({ status: 'PENDING', submittedAt: T0 + 31 * MIN, officialChaseMsAtClaim: 21 * MIN });
    const pending = submitClaim(r, claim(), SEEKER, T0 + 31 * MIN).round;
    const safety = requestPause(pending, SEEKER, 'SAFETY', 'Riley twisted an ankle', T0 + 31 * MIN + 1500).round;
    rounds.push([pending, T0 + 31 * MIN + 1000], [safety, T0 + 31 * MIN + 2000]);
    rounds.push([decideClaim(pending, c, HIDER, 'CONFIRM', null, T0 + 32 * MIN).round, T0 + 32 * MIN]);
    const allowed = ['chaseElapsed', 'chaseStartedAt', 'claim', 'headStartEndsAt', 'headStartRemaining', 'lastPing', 'nextPingAt', 'nextPingIndex', 'outcome', 'pausedPhase', 'phase', 'pingWaiting', 'safetyPause', 'timeCapAt'];
    for (const [round, now] of rounds) {
      for (const uid of [SEEKER, SEEKER2, HIDER, HIDER2]) {
        const v = renderView({ uid, session: s, round, members: members(s), activeClaim: round.state === 'CAPTURE_PENDING' ? c : null, now });
        const state = liveActivityState(v.round!, 1234)!;
        const attrs = liveActivityAttributes(v)!;
        expect(Object.keys(state).sort()).toEqual(allowed);
        expect(Object.keys(attrs).sort()).toEqual(['crew', 'crewName', 'role', 'roundId', 'roundIndex', 'sessionId']);
        expect(numbers(state).filter((n) => coords.has(n))).toEqual([]);
        const json = JSON.stringify({ attrs, state });
        for (const leak of [HIDER, HIDER2, SEEKER, SEEKER2, 'Morgan', 'Taylor', 'twisted', 'latitude', 'longitude', 'photoPath', 'sourceUid']) expect(json).not.toContain(leak);
        // ActivityKit caps static + dynamic data at 4 KB.
        expect(Buffer.byteLength(json)).toBeLessThan(1024);
      }
    }
    // A phone that isn't playing the round (joined after the start) gets no Live Activity.
    const late = { ...s, teams: { ...s.teams, B: { ...s.teams.B!, operatorUids: [SEEKER, SEEKER2, 'late-phone'] } } };
    const lv = renderView({ uid: 'late-phone', session: late, round: r, members: members(late), activeClaim: null, now: T0 + 31 * MIN });
    expect(liveActivityState(lv.round!)).toBeNull();
    expect(liveActivityAttributes(lv)).toBeNull();
  });

  it('stateVersion grows with every committed session or round change', () => {
    const { session: s, round } = readyRound();
    const v1 = renderView({ uid: SEEKER, session: s, round, members: members(s), activeClaim: null, now: T0 }).stateVersion;
    const v2 = renderView({ uid: SEEKER, session: s, round: { ...round, version: round.version + 1 }, members: members(s), activeClaim: null, now: T0 - 5000 }).stateVersion;
    const v3 = renderView({ uid: SEEKER, session: { ...s, version: s.version + 1 }, round: { ...round, version: 1 }, members: members(s), activeClaim: null, now: T0 - 9000 }).stateVersion;
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
  });
});
