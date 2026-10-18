/**
 * GPS route processing: distance estimation, coverage, jitter/spike rejection
 * and Douglas–Peucker simplification. All distances are meters internally.
 *
 * Thresholds (documented in docs/scoring-and-privacy.md):
 *  - samples worse than `maxAccuracyMeters` (default 50 m) are ignored;
 *  - movement smaller than max(5 m, 0.5 × mean accuracy) is treated as jitter;
 *    the anchor is not advanced, so slow real movement still accumulates;
 *  - speeds above the role's plausible maximum are spikes and ignored;
 *  - consecutive samples more than `maxGapSeconds` (default 120 s) apart start
 *    a new segment and the straight line across the gap is NOT counted.
 */

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface TrackSample extends LatLon {
  pointId: string;
  recordedAt: number;
  horizontalAccuracyMeters: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0)
  );
}

export interface DistanceOptions {
  from: number;
  to: number;
  maxAccuracyMeters: number;
  maxSpeedMps: number;
  maxGapSeconds: number;
  minMoveMeters: number;
}

export const ROLE_MAX_SPEED_MPS = { HIDING: 12, SEEKING: 60 } as const;
/** Generic GPS spike threshold used for ping eligibility (independent of role). */
export const SPIKE_SPEED_MPS = 70;

export const DEFAULT_DISTANCE_OPTIONS: Omit<DistanceOptions, 'from' | 'to' | 'maxSpeedMps'> = {
  maxAccuracyMeters: 50,
  maxGapSeconds: 120,
  minMoveMeters: 5,
};

export interface DistanceResult {
  meters: number;
  coveredMs: number;
  windowMs: number;
  coverageFraction: number | null;
  acceptedSamples: number;
  rejectedLowAccuracy: number;
  rejectedSpikes: number;
  gaps: { from: number; to: number }[];
}

export function sortAndDedupe<T extends TrackSample>(samples: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of [...samples].sort((a, b) => a.recordedAt - b.recordedAt || a.pointId.localeCompare(b.pointId))) {
    if (seen.has(s.pointId)) continue;
    seen.add(s.pointId);
    out.push(s);
  }
  return out;
}

export function computeDistance(samples: readonly TrackSample[], opts: DistanceOptions): DistanceResult {
  const windowMs = Math.max(0, opts.to - opts.from);
  const inWindow = sortAndDedupe(samples).filter((s) => s.recordedAt >= opts.from && s.recordedAt <= opts.to);
  let rejectedLowAccuracy = 0;
  let rejectedSpikes = 0;
  const usable = inWindow.filter((s) => {
    const ok = s.horizontalAccuracyMeters > 0 && s.horizontalAccuracyMeters <= opts.maxAccuracyMeters;
    if (!ok) rejectedLowAccuracy++;
    return ok && isValidCoordinate(s.latitude, s.longitude);
  });

  let meters = 0;
  let coveredMs = 0;
  const gaps: { from: number; to: number }[] = [];
  let anchor: TrackSample | null = null;
  let last: TrackSample | null = null;
  let consecutiveSpikes = 0;
  let accepted = 0;
  const maxGapMs = opts.maxGapSeconds * 1000;

  for (const p of usable) {
    if (!anchor || !last) {
      anchor = p;
      last = p;
      accepted++;
      continue;
    }
    const dtLast = p.recordedAt - last.recordedAt;
    if (dtLast > maxGapMs) {
      gaps.push({ from: last.recordedAt, to: p.recordedAt });
      anchor = p;
      last = p;
      consecutiveSpikes = 0;
      accepted++;
      continue;
    }
    const dtAnchor = Math.max(1, p.recordedAt - anchor.recordedAt);
    const d = haversineMeters(anchor, p);
    const speed = d / (dtAnchor / 1000);
    const lastSpeed = haversineMeters(last, p) / (Math.max(1, dtLast) / 1000);
    if (speed > opts.maxSpeedMps && lastSpeed > opts.maxSpeedMps) {
      rejectedSpikes++;
      consecutiveSpikes++;
      if (consecutiveSpikes >= 3) {
        // Persistent displacement: treat as a discontinuity rather than a spike.
        gaps.push({ from: last.recordedAt, to: p.recordedAt });
        anchor = p;
        last = p;
        consecutiveSpikes = 0;
        accepted++;
      }
      continue;
    }
    consecutiveSpikes = 0;
    coveredMs += dtLast;
    accepted++;
    last = p;
    const jitter = Math.max(opts.minMoveMeters, 0.5 * ((anchor.horizontalAccuracyMeters + p.horizontalAccuracyMeters) / 2));
    if (d >= jitter) {
      meters += d;
      anchor = p;
    }
  }

  return {
    meters: Math.round(meters * 10) / 10,
    coveredMs,
    windowMs,
    coverageFraction: windowMs > 0 ? Math.min(1, coveredMs / windowMs) : null,
    acceptedSamples: accepted,
    rejectedLowAccuracy,
    rejectedSpikes,
    gaps,
  };
}

/** Perpendicular distance (m) of p from segment ab using a local equirectangular projection. */
function perpendicularMeters(p: LatLon, a: LatLon, b: LatLon): number {
  const lat0 = toRad((a.latitude + b.latitude) / 2);
  const x = (q: LatLon) => toRad(q.longitude) * Math.cos(lat0) * EARTH_RADIUS_M;
  const y = (q: LatLon) => toRad(q.latitude) * EARTH_RADIUS_M;
  const ax = x(a), ay = y(a), bx = x(b), by = y(b), px = x(p), py = y(p);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Iterative Douglas–Peucker; always keeps first and last points. */
export function simplify<T extends LatLon>(points: readonly T[], toleranceMeters: number): T[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpendicularMeters(points[i]!, points[s]!, points[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceMeters) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

export interface RouteSegmentPoint {
  lat: number;
  lon: number;
  t: number;
}

/**
 * Build simplified polyline segments (split at data gaps) for recap maps.
 * Only accuracy-qualified samples are drawn; nothing is interpolated.
 */
export function buildRouteSegments(
  samples: readonly TrackSample[],
  opts: { maxAccuracyMeters: number; maxGapSeconds: number; toleranceMeters: number; maxSpeedMps: number },
): RouteSegmentPoint[][] {
  const usable = sortAndDedupe(samples).filter(
    (s) => s.horizontalAccuracyMeters > 0 && s.horizontalAccuracyMeters <= opts.maxAccuracyMeters && isValidCoordinate(s.latitude, s.longitude),
  );
  const segments: TrackSample[][] = [];
  let current: TrackSample[] = [];
  for (const p of usable) {
    const prev = current[current.length - 1];
    if (prev) {
      const dt = p.recordedAt - prev.recordedAt;
      const speed = haversineMeters(prev, p) / (Math.max(1, dt) / 1000);
      if (dt > opts.maxGapSeconds * 1000) {
        segments.push(current);
        current = [];
      } else if (speed > opts.maxSpeedMps) {
        continue; // spike
      }
    }
    current.push(p);
  }
  if (current.length) segments.push(current);
  return segments
    .filter((seg) => seg.length > 0)
    .map((seg) => simplify(seg, opts.toleranceMeters).map((p) => ({ lat: round6(p.latitude), lon: round6(p.longitude), t: p.recordedAt })));
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
