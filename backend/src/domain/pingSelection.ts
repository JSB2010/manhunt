import { isWithinPause } from './clock.js';
import { haversineMeters, isValidCoordinate, SPIKE_SPEED_MPS } from './geo.js';
import type { GpsPoint, PauseInterval } from './types.js';

export interface PingSelectionParams {
  deadline: number;
  hiderUid: string;
  roundStartAt: number;
  maxAgeSeconds: number;
  maxAccuracyMeters: number;
  pauses: readonly PauseInterval[];
}

/** Flags that permanently disqualify a sample from being released as a ping. */
export const DISQUALIFYING_FLAGS = new Set(['CLOCK_UNTRUSTED', 'FUTURE_TIMESTAMP', 'INVALID_COORDINATE']);

/**
 * Spec §5.3 eligibility. Returns the latest qualified hider sample for a
 * scheduled deadline, or null (→ NO_FRESH_FIX ping with no coordinates).
 *
 * Invariants enforced here:
 *  1. sample belongs to the designated hiding operator for this round;
 *  2. recordedAt <= deadline AND receivedAt <= deadline (late uploads are
 *     never revealed retroactively, even when the worker runs late);
 *  3. deadline - recordedAt <= maxAge;
 *  4. accuracy <= maxAccuracy and not an anomaly/spike;
 *  5. recorded inside the official active period and not during any pause or
 *     capture-pending interval.
 *
 * `candidates` may contain anything (the caller's query window); filtering is
 * done here so the rule lives in one tested place.
 */
export function selectPingSample(candidates: readonly GpsPoint[], p: PingSelectionParams): GpsPoint | null {
  const maxAgeMs = p.maxAgeSeconds * 1000;
  const hiderPoints = candidates
    .filter((c) => c.operatorUid === p.hiderUid && c.role === 'HIDING')
    .sort((a, b) => b.recordedAt - a.recordedAt || b.receivedAt - a.receivedAt || a.pointId.localeCompare(b.pointId));

  const eligible = (c: GpsPoint) =>
    c.recordedAt <= p.deadline &&
    c.receivedAt <= p.deadline &&
    p.deadline - c.recordedAt <= maxAgeMs &&
    c.recordedAt >= p.roundStartAt &&
    c.horizontalAccuracyMeters > 0 &&
    c.horizontalAccuracyMeters <= p.maxAccuracyMeters &&
    isValidCoordinate(c.latitude, c.longitude) &&
    !c.qualityFlags.some((f) => DISQUALIFYING_FLAGS.has(f)) &&
    !isWithinPause(p.pauses, c.recordedAt, p.deadline);

  // Points the server already knew about at the deadline (for spike checks).
  const knownAtDeadline = hiderPoints.filter(
    (c) => c.receivedAt <= p.deadline && c.recordedAt <= p.deadline && c.horizontalAccuracyMeters <= p.maxAccuracyMeters,
  );

  for (const c of hiderPoints) {
    if (!eligible(c)) continue;
    const prev = knownAtDeadline.find((k) => k.recordedAt < c.recordedAt && c.recordedAt - k.recordedAt <= 5 * 60_000);
    if (prev) {
      const dt = Math.max(1, c.recordedAt - prev.recordedAt) / 1000;
      if (haversineMeters(prev, c) / dt > SPIKE_SPEED_MPS) continue;
    }
    return c;
  }
  return null;
}
