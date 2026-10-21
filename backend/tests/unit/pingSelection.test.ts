import { describe, expect, it } from 'vitest';
import { FRESHNESS_TIE_MS, hiderSpreadMeters, selectLateSample, selectPingSample } from '../../src/domain/pingSelection.js';
import type { PauseInterval } from '../../src/domain/types.js';
import { HIDER, HIDER2, point, SEEKER, T0 } from './fixtures.js';

const D = T0 + 600_000; // deadline
const params = (over: Partial<Parameters<typeof selectPingSample>[1]> = {}) => ({
  deadline: D,
  hiderUids: [HIDER],
  roundStartAt: T0,
  maxAgeSeconds: 60,
  maxAccuracyMeters: 50,
  pauses: [] as PauseInterval[],
  ...over,
});

describe('ping eligibility (spec §5.3)', () => {
  it('picks the latest qualified hider sample', () => {
    const a = point({ recordedAt: D - 30_000, receivedAt: D - 25_000 });
    const b = point({ recordedAt: D - 10_000, receivedAt: D - 5_000 });
    expect(selectPingSample([a, b], params())?.pointId).toBe(b.pointId);
  });

  it('never uses a sample received after the deadline (no retroactive reveal)', () => {
    const early = point({ recordedAt: D - 40_000, receivedAt: D - 35_000 });
    const lateUpload = point({ recordedAt: D - 5_000, receivedAt: D + 1_000 });
    expect(selectPingSample([early, lateUpload], params())?.pointId).toBe(early.pointId);
    // an offline batch delivered hours later never qualifies
    const offline = point({ recordedAt: D - 2_000, receivedAt: D + 3_600_000 });
    expect(selectPingSample([offline], params())).toBeNull();
  });

  it('never uses a future sample', () => {
    expect(selectPingSample([point({ recordedAt: D + 1, receivedAt: D - 1 })], params())).toBeNull();
  });

  it('rejects stale and inaccurate fixes', () => {
    expect(selectPingSample([point({ recordedAt: D - 61_000, receivedAt: D - 60_000 })], params())).toBeNull();
    expect(selectPingSample([point({ recordedAt: D - 5_000, receivedAt: D - 4_000, horizontalAccuracyMeters: 51 })], params())).toBeNull();
    expect(selectPingSample([point({ recordedAt: D - 60_000, receivedAt: D - 59_000 })], params())).not.toBeNull();
  });

  it("only considers the hiding crew's phones in the round snapshot", () => {
    const seekerPt = point({ recordedAt: D - 5_000, operatorUid: SEEKER, role: 'SEEKING', teamKey: 'B' });
    const otherHider = point({ recordedAt: D - 5_000, operatorUid: 'imposter' });
    expect(selectPingSample([seekerPt, otherHider], params())).toBeNull();
  });

  it('excludes samples from before the round and during pauses', () => {
    expect(selectPingSample([point({ recordedAt: T0 - 1000, receivedAt: T0 })], params({ deadline: T0 + 30_000 }))).toBeNull();
    const pause: PauseInterval = { id: 'x', kind: 'CAPTURE', startAt: D - 50_000, endAt: D - 20_000, phase: 'CHASE', requestedByUid: null, confirmedByUid: null, reason: null };
    const inPause = point({ recordedAt: D - 30_000, receivedAt: D - 29_000 });
    expect(selectPingSample([inPause], params({ pauses: [pause] }))).toBeNull();
  });

  it('skips GPS spikes', () => {
    const base = point({ recordedAt: D - 20_000, receivedAt: D - 19_000, latitude: 39.7392, longitude: -104.9903 });
    const spike = point({ recordedAt: D - 10_000, receivedAt: D - 9_000, latitude: 39.76, longitude: -104.9903 }); // ~2.3 km in 10 s
    expect(selectPingSample([base, spike], params())?.pointId).toBe(base.pointId);
  });

  it('skips untrusted clock samples', () => {
    expect(selectPingSample([point({ recordedAt: D - 5_000, qualityFlags: ['CLOCK_UNTRUSTED'] })], params())).toBeNull();
  });
});

describe('several hider phones', () => {
  const both = params({ hiderUids: [HIDER, HIDER2] });

  it('takes the freshest fix across phones', () => {
    const a = point({ operatorUid: HIDER, recordedAt: D - 40_000, receivedAt: D - 39_000 });
    const b = point({ operatorUid: HIDER2, recordedAt: D - 20_000, receivedAt: D - 19_000 });
    expect(selectPingSample([a, b], both)?.pointId).toBe(b.pointId);
  });

  it('within the freshness tie window, the more accurate fix wins', () => {
    const fresh = point({ operatorUid: HIDER, recordedAt: D - 5_000, receivedAt: D - 4_000, horizontalAccuracyMeters: 40 });
    const precise = point({ operatorUid: HIDER2, recordedAt: D - 5_000 - FRESHNESS_TIE_MS + 1000, receivedAt: D - 10_000, horizontalAccuracyMeters: 6 });
    expect(selectPingSample([fresh, precise], both)?.pointId).toBe(precise.pointId);
    const older = point({ operatorUid: HIDER2, recordedAt: D - 5_000 - FRESHNESS_TIE_MS - 1000, receivedAt: D - 10_000, horizontalAccuracyMeters: 6 });
    expect(selectPingSample([fresh, older], both)?.pointId).toBe(fresh.pointId);
  });

  it('checks spikes per phone: two phones a block apart are not a teleport', () => {
    const a = point({ operatorUid: HIDER, recordedAt: D - 20_000, receivedAt: D - 19_000, latitude: 39.7392, longitude: -104.9903 });
    const b = point({ operatorUid: HIDER2, recordedAt: D - 10_000, receivedAt: D - 9_000, latitude: 39.745, longitude: -104.9903 }); // ~650 m from a in 10 s
    expect(selectPingSample([a, b], both)?.pointId).toBe(b.pointId);
    expect(hiderSpreadMeters([a, b])).toBeGreaterThan(600);
  });
});

describe('late release of a waiting ping (ADR 0015)', () => {
  const now = D + 5 * 60_000;
  const late = (over: Partial<Parameters<typeof selectLateSample>[1]> = {}) => ({
    deadline: D,
    hiderUids: [HIDER, HIDER2],
    now,
    maxAgeSeconds: 60,
    maxAccuracyMeters: 50,
    pauses: [] as PauseInterval[],
    ...over,
  });

  it('releases only a current fix, never a backlog point from the outage', () => {
    const backlog = [1, 2, 3, 4].map((m) => point({ recordedAt: D + m * 60_000 - 30_000, receivedAt: now - 1000 }));
    expect(selectLateSample(backlog, late())).toBeNull();
    const current = point({ operatorUid: HIDER2, recordedAt: now - 10_000, receivedAt: now - 1000 });
    expect(selectLateSample([...backlog, current], late())?.pointId).toBe(current.pointId);
  });

  it('never releases a fix recorded before the missed deadline', () => {
    const before = point({ recordedAt: D - 1000, receivedAt: D + 10_000 });
    expect(selectLateSample([before], late({ now: D + 20_000 }))).toBeNull();
  });

  it('holds while a pause is open and ignores fixes from before the last pause ended', () => {
    const fix = point({ recordedAt: now - 10_000, receivedAt: now - 1000 });
    const open: PauseInterval = { id: 'p', kind: 'SAFETY', startAt: now - 60_000, endAt: null, phase: 'CHASE', requestedByUid: null, confirmedByUid: null, reason: null };
    expect(selectLateSample([fix], late({ pauses: [open] }))).toBeNull();
    const closed = { ...open, endAt: now - 5_000 };
    expect(selectLateSample([fix], late({ pauses: [closed] }))).toBeNull();
    const after = point({ recordedAt: now - 2_000, receivedAt: now - 1000 });
    expect(selectLateSample([fix, after], late({ pauses: [closed] }))?.pointId).toBe(after.pointId);
  });

  it('ignores phones outside the hiding crew and seeker points', () => {
    const seekerPt = point({ operatorUid: SEEKER, role: 'SEEKING', teamKey: 'B', recordedAt: now - 5000, receivedAt: now - 1000 });
    const outsider = point({ operatorUid: 'late-phone', recordedAt: now - 5000, receivedAt: now - 1000 });
    expect(selectLateSample([seekerPt, outsider], late())).toBeNull();
  });
});
