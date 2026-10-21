import { isWithinPause } from './clock.js';
import { haversineMeters, isValidCoordinate, SPIKE_SPEED_MPS } from './geo.js';
import type { GpsPoint, PauseInterval } from './types.js';

export interface PingSelectionParams {
  deadline: number;
  /** the hiding crew's phones in this round's snapshot */
  hiderUids: readonly string[];
  roundStartAt: number;
  maxAgeSeconds: number;
  maxAccuracyMeters: number;
  pauses: readonly PauseInterval[];
}

/** Flags that permanently disqualify a sample from being released as a ping. */
export const DISQUALIFYING_FLAGS = new Set(['CLOCK_UNTRUSTED', 'FUTURE_TIMESTAMP', 'INVALID_COORDINATE']);

/** Two fixes recorded within this window count as a tie; the more accurate one wins. */
export const FRESHNESS_TIE_MS = 10_000;

const newestFirst = (a: GpsPoint, b: GpsPoint) => b.recordedAt - a.recordedAt || b.receivedAt - a.receivedAt || a.pointId.localeCompare(b.pointId);

const usable = (c: GpsPoint, maxAccuracyMeters: number) =>
  c.horizontalAccuracyMeters > 0 &&
  c.horizontalAccuracyMeters <= maxAccuracyMeters &&
  isValidCoordinate(c.latitude, c.longitude) &&
  !c.qualityFlags.some((f) => DISQUALIFYING_FLAGS.has(f));

/**
 * Spike check against the same phone's previous known point. Checking per
 * phone matters: two hider phones a block apart are not a teleport.
 */
function isSpike(c: GpsPoint, known: readonly GpsPoint[]): boolean {
  const prev = known.find((k) => k.operatorUid === c.operatorUid && k.recordedAt < c.recordedAt && c.recordedAt - k.recordedAt <= 5 * 60_000);
  if (!prev) return false;
  const dt = Math.max(1, c.recordedAt - prev.recordedAt) / 1000;
  return haversineMeters(prev, c) / dt > SPIKE_SPEED_MPS;
}

/** Freshest of the qualified fixes; within FRESHNESS_TIE_MS the more accurate fix wins. */
function pickFreshest(qualified: GpsPoint[]): GpsPoint | null {
  const best = qualified[0];
  if (!best) return null;
  const ties = qualified.filter((c) => best.recordedAt - c.recordedAt <= FRESHNESS_TIE_MS);
  ties.sort((a, b) => a.horizontalAccuracyMeters - b.horizontalAccuracyMeters || newestFirst(a, b));
  return ties[0]!;
}

/**
 * Spec §5.3 eligibility, across every phone of the hiding crew. Returns the
 * freshest qualified fix for a scheduled deadline, or null (→ the ping waits,
 * ADR 0015).
 *
 * Invariants enforced here:
 *  1. sample comes from one of the hiding crew's phones in this round;
 *  2. recordedAt <= deadline AND receivedAt <= deadline (late uploads are
 *     never revealed retroactively as the deadline position);
 *  3. deadline - recordedAt <= maxAge;
 *  4. accuracy <= maxAccuracy and not an anomaly/spike (per phone);
 *  5. recorded inside the official active period and not during any pause or
 *     capture-pending interval.
 *
 * `candidates` may contain anything (the caller's query window); filtering is
 * done here so the rule lives in one tested place.
 */
export function selectPingSample(candidates: readonly GpsPoint[], p: PingSelectionParams): GpsPoint | null {
  const maxAgeMs = p.maxAgeSeconds * 1000;
  const hiders = new Set(p.hiderUids);
  const hiderPoints = candidates.filter((c) => hiders.has(c.operatorUid) && c.role === 'HIDING').sort(newestFirst);
  // Points the server already knew about at the deadline (for spike checks).
  const knownAtDeadline = hiderPoints.filter(
    (c) => c.receivedAt <= p.deadline && c.recordedAt <= p.deadline && c.horizontalAccuracyMeters <= p.maxAccuracyMeters,
  );
  const qualified = hiderPoints.filter(
    (c) =>
      c.recordedAt <= p.deadline &&
      c.receivedAt <= p.deadline &&
      p.deadline - c.recordedAt <= maxAgeMs &&
      c.recordedAt >= p.roundStartAt &&
      usable(c, p.maxAccuracyMeters) &&
      !isWithinPause(p.pauses, c.recordedAt, p.deadline) &&
      !isSpike(c, knownAtDeadline),
  );
  return pickFreshest(qualified);
}

export interface LateSelectionParams {
  /** deadline of the waiting ping */
  deadline: number;
  hiderUids: readonly string[];
  now: number;
  maxAgeSeconds: number;
  maxAccuracyMeters: number;
  pauses: readonly PauseInterval[];
}

/**
 * Release rule for a waiting ping (ADR 0015): the hiders' CURRENT position.
 * A fix qualifies only if it was recorded at or after the missed deadline,
 * after the most recent pause ended, and no more than maxAge before now — so a
 * backlog of points from an offline stretch is never revealed, only where the
 * crew is now. Same accuracy, flag and per-phone spike checks as on-time pings.
 */
export function selectLateSample(candidates: readonly GpsPoint[], p: LateSelectionParams): GpsPoint | null {
  const maxAgeMs = p.maxAgeSeconds * 1000;
  const hiders = new Set(p.hiderUids);
  const lastPauseEnd = Math.max(0, ...p.pauses.map((x) => x.endAt ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(lastPauseEnd)) return null; // a pause is open: hold the ping
  const notBefore = Math.max(p.deadline, lastPauseEnd, p.now - maxAgeMs);
  const hiderPoints = candidates.filter((c) => hiders.has(c.operatorUid) && c.role === 'HIDING' && c.receivedAt <= p.now).sort(newestFirst);
  const known = hiderPoints.filter((c) => c.horizontalAccuracyMeters <= p.maxAccuracyMeters);
  const qualified = hiderPoints.filter(
    (c) =>
      c.recordedAt >= notBefore &&
      c.recordedAt <= p.now &&
      usable(c, p.maxAccuracyMeters) &&
      !isWithinPause(p.pauses, c.recordedAt, p.now) &&
      !isSpike(c, known),
  );
  return pickFreshest(qualified);
}

/** Largest distance between the latest fixes of different hider phones (audit for split or decoy phones). */
export function hiderSpreadMeters(points: readonly GpsPoint[]): number {
  const latest = new Map<string, GpsPoint>();
  for (const c of [...points].sort(newestFirst)) if (!latest.has(c.operatorUid)) latest.set(c.operatorUid, c);
  const xs = [...latest.values()];
  let max = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) max = Math.max(max, haversineMeters(xs[i]!, xs[j]!));
  return max;
}
