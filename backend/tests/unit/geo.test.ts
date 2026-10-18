import { describe, expect, it } from 'vitest';
import { buildRouteSegments, computeDistance, haversineMeters, simplify, type TrackSample } from '../../src/domain/geo.js';

const T = 1_700_000_000_000;
// ~1.11 m per 1e-5 deg latitude
const walk = (n: number, stepDeg: number, dtMs: number, acc = 5, startLat = 39.7, lon = -104.99): TrackSample[] =>
  Array.from({ length: n }, (_, i) => ({ pointId: `p${i}`, recordedAt: T + i * dtMs, latitude: startLat + i * stepDeg, longitude: lon, horizontalAccuracyMeters: acc }));

const opts = (over = {}) => ({ from: T, to: T + 3_600_000, maxAccuracyMeters: 50, maxSpeedMps: 12, maxGapSeconds: 120, minMoveMeters: 5, ...over });

describe('haversine', () => {
  it('matches known distances', () => {
    expect(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111_195, -2);
    expect(haversineMeters({ latitude: 39.7392, longitude: -104.9903 }, { latitude: 39.7392, longitude: -104.9903 })).toBe(0);
  });
});

describe('distance estimation', () => {
  it('sums consecutive accepted observations', () => {
    // 61 samples, 10 s apart, 15 m steps = 900 m
    const d = computeDistance(walk(61, 15 / 111_195, 10_000), opts());
    expect(d.meters).toBeGreaterThan(890);
    expect(d.meters).toBeLessThan(910);
    expect(d.gaps).toHaveLength(0);
  });

  it('ignores stationary jitter', () => {
    const jitter: TrackSample[] = Array.from({ length: 60 }, (_, i) => ({
      pointId: `j${i}`,
      recordedAt: T + i * 10_000,
      latitude: 39.7 + (i % 2 ? 2e-5 : -2e-5),
      longitude: -104.99,
      horizontalAccuracyMeters: 10,
    }));
    expect(computeDistance(jitter, opts()).meters).toBeLessThan(10);
  });

  it('accumulates slow real movement despite the jitter threshold', () => {
    // 2 m per 10 s sample — below threshold step-by-step, but 118 m total
    const d = computeDistance(walk(60, 2 / 111_195, 10_000), opts());
    expect(d.meters).toBeGreaterThan(100);
  });

  it('rejects low-accuracy fixes and spikes', () => {
    const pts = walk(30, 10 / 111_195, 10_000);
    pts[10] = { ...pts[10]!, latitude: pts[10]!.latitude + 0.02 }; // 2.2 km spike
    pts[20] = { ...pts[20]!, horizontalAccuracyMeters: 200 };
    const d = computeDistance(pts, opts());
    expect(d.rejectedSpikes).toBe(1);
    expect(d.rejectedLowAccuracy).toBe(1);
    expect(d.meters).toBeLessThan(300);
  });

  it('does not count straight lines across large gaps and reports coverage', () => {
    const a = walk(10, 10 / 111_195, 10_000);
    const b = walk(10, 10 / 111_195, 10_000, 5, 39.71).map((p, i) => ({ ...p, pointId: `b${i}`, recordedAt: T + 600_000 + i * 10_000 }));
    const d = computeDistance([...a, ...b], opts({ to: T + 700_000 }));
    expect(d.gaps).toHaveLength(1);
    expect(d.meters).toBeLessThan(200); // the 1.1 km jump is not counted
    expect(d.coverageFraction!).toBeLessThan(0.3);
  });

  it('respects the time window', () => {
    const d = computeDistance(walk(61, 15 / 111_195, 10_000), opts({ from: T + 300_000, to: T + 600_000 }));
    expect(d.meters).toBeGreaterThan(440);
    expect(d.meters).toBeLessThan(460);
  });
});

describe('simplification', () => {
  it('keeps endpoints and corners, drops collinear points', () => {
    const line = walk(50, 1e-4, 1000);
    const corner = [...line, ...Array.from({ length: 50 }, (_, i) => ({ ...line[49]!, pointId: `c${i}`, longitude: -104.99 + (i + 1) * 1e-4, recordedAt: T + 50_000 + i * 1000 }))];
    const s = simplify(corner, 5);
    expect(s[0]).toBe(corner[0]);
    expect(s[s.length - 1]).toBe(corner[corner.length - 1]);
    expect(s.length).toBeLessThanOrEqual(4);
  });

  it('splits route segments at gaps', () => {
    const a = walk(10, 1e-4, 10_000);
    const b = walk(10, 1e-4, 10_000, 5, 39.8).map((p, i) => ({ ...p, pointId: `b${i}`, recordedAt: T + 1_000_000 + i * 10_000 }));
    const segs = buildRouteSegments([...a, ...b], { maxAccuracyMeters: 50, maxGapSeconds: 120, toleranceMeters: 8, maxSpeedMps: 60 });
    expect(segs).toHaveLength(2);
  });
});
