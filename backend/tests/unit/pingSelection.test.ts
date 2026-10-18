import { describe, expect, it } from 'vitest';
import { selectPingSample } from '../../src/domain/pingSelection.js';
import type { PauseInterval } from '../../src/domain/types.js';
import { HIDER, point, SEEKER, T0 } from './fixtures.js';

const D = T0 + 600_000; // deadline
const params = (over: Partial<Parameters<typeof selectPingSample>[1]> = {}) => ({
  deadline: D,
  hiderUid: HIDER,
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

  it('only considers the designated hiding operator', () => {
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
