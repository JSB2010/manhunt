import { describe, expect, it } from 'vitest';
import { decideClaim, startRound, submitClaim } from '../../src/domain/engine.js';
import { tickRound } from '../../src/domain/tick.js';
import type { GpsPoint, RoundDoc } from '../../src/domain/types.js';
import { renderView } from '../../src/domain/views.js';
import { claim, HIDER, members, MIN, point, readyRound, SEEKER, T0 } from './fixtures.js';

/** Recursively collect every numeric value in an object. */
function numbers(o: unknown, out: number[] = []): number[] {
  if (typeof o === 'number') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => numbers(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => numbers(x, out));
  return out;
}

/** Hider walk with distinctive coordinates so any leak is detectable. */
function track(until: number): GpsPoint[] {
  const pts: GpsPoint[] = [];
  let i = 0;
  for (let t = T0; t <= until; t += 7_000) {
    pts.push(point({ recordedAt: t, receivedAt: t + 2_000, latitude: 39.7 + i * 0.000123, longitude: -105.1 - i * 0.000321 }));
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
    let r: RoundDoc = startRound(r0, s, SEEKER, [], T0).round;
    const sampleCoords = new Set(all.flatMap((p) => [p.latitude, p.longitude]));

    const check = (round: RoundDoc, now: number) => {
      const v = renderView({ uid: SEEKER, session: s, round, members: members(), activeClaim: null, now });
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
      r = (await tickRound(r, T0 + m * MIN, { candidatesForDeadline: async () => all, activeClaim: null })).round;
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
    let r = startRound(r0, s, HIDER, [], T0).round;
    r = (await tickRound(r, T0 + 12 * MIN, { candidatesForDeadline: async () => track(T0 + 12 * MIN), activeClaim: null })).round;
    const c = { ...claim(), status: 'PENDING' as const, submittedAt: T0 + 13 * MIN, officialChaseMsAtClaim: 3 * MIN };
    r = submitClaim(r, claim(), SEEKER, T0 + 13 * MIN).round;
    const hv = renderView({ uid: HIDER, session: s, round: r, members: members(), activeClaim: c, now: T0 + 13 * MIN + 1000 });
    expect(hv.round!.myRole).toBe('HIDING');
    expect(hv.round!.captureRequest?.claimId).toBe('claim1');
    expect(hv.round!.captureRequest?.chaseSecondsAtClaim).toBe(180);
    const sv = renderView({ uid: SEEKER, session: s, round: r, members: members(), activeClaim: c, now: T0 + 13 * MIN + 1000 });
    expect(sv.round!.captureRequest).toBeNull();
    expect(sv.round!.myClaim?.status).toBe('PENDING');
    // clocks freeze while pending
    expect(sv.round!.chaseClock).toEqual({ accumulatedMs: 3 * MIN, runningSince: null });
    const done = decideClaim(r, c, HIDER, 'CONFIRM', null, T0 + 14 * MIN).round;
    const after = renderView({ uid: SEEKER, session: s, round: done, members: members(), activeClaim: null, now: T0 + 14 * MIN });
    expect(after.round!.result?.observedChaseSeconds).toBe(180);
  });

  it('opponent health is coarse and coordinate-free', () => {
    const { session: s, round } = readyRound();
    const m = members();
    m[HIDER]!.health.lastHeartbeatAt = T0 + 17_345;
    const v = renderView({ uid: SEEKER, session: s, round, members: m, activeClaim: null, now: T0 + 20_000 });
    expect(v.round!.opponentHealth.lastHeartbeatAt).toBe(new Date(T0).toISOString());
    expect(v.round!.opponentHealth.state).toBe('ACTIVE');
    expect(Object.keys(v.round!.opponentHealth).sort()).toEqual(['issues', 'lastHeartbeatAt', 'state']);
  });

  it('clock view lets clients compute elapsed from server timestamps', async () => {
    const { session: s, round: r0 } = readyRound();
    let r = startRound(r0, s, HIDER, [], T0).round;
    r = (await tickRound(r, T0 + 15 * MIN, { candidatesForDeadline: async () => [], activeClaim: null })).round;
    const v = renderView({ uid: SEEKER, session: s, round: r, members: members(), activeClaim: null, now: T0 + 15 * MIN });
    const c = v.round!.chaseClock!;
    const elapsedAt = (now: number) => c.accumulatedMs + (now - Date.parse(c.runningSince!));
    expect(elapsedAt(T0 + 15 * MIN)).toBe(5 * MIN);
    expect(elapsedAt(T0 + 16 * MIN)).toBe(6 * MIN);
    expect(v.round!.nextPingAt).toBe(new Date(T0 + 20 * MIN).toISOString());
  });
});
