import type { PauseInterval, RoundDoc } from './types.js';

/**
 * Pause-aware clock math. All game timers are derived from persisted
 * `roundStartAt`, `chaseStartAt` and `pauses` — never from device timers.
 *
 * Pauses may overlap (e.g. a SAFETY pause during a CAPTURE pending interval),
 * so every computation works on the *union* of pause intervals.
 */

type Span = { start: number; end: number };

/** Merge pause intervals (open intervals end at `openEnd`) into a sorted disjoint union. */
export function pauseUnion(pauses: readonly PauseInterval[], openEnd: number): Span[] {
  const spans = pauses
    .map((p) => ({ start: p.startAt, end: p.endAt ?? openEnd }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Milliseconds of [from, to) covered by pauses. */
export function pausedOverlapMs(pauses: readonly PauseInterval[], from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  for (const s of pauseUnion(pauses, to)) {
    const a = Math.max(s.start, from);
    const b = Math.min(s.end, to);
    if (b > a) total += b - a;
  }
  return total;
}

/** Effective (pause-excluded) elapsed ms since `phaseStart` at wall time `now`. */
export function effectiveElapsedMs(pauses: readonly PauseInterval[], phaseStart: number, now: number): number {
  if (now <= phaseStart) return 0;
  return now - phaseStart - pausedOverlapMs(pauses, phaseStart, now);
}

export function hasOpenPause(pauses: readonly PauseInterval[]): boolean {
  return pauses.some((p) => p.endAt === null);
}

/**
 * Inverse of effectiveElapsedMs: the earliest wall time at which `targetEffectiveMs`
 * of un-paused time will have elapsed since `phaseStart`, given the pauses known
 * so far. Returns null while a pause is open and the target lies beyond its start
 * (the deadline cannot be known until the pause ends).
 */
export function wallTimeForEffective(
  pauses: readonly PauseInterval[],
  phaseStart: number,
  targetEffectiveMs: number,
): number | null {
  if (targetEffectiveMs <= 0) return phaseStart;
  const spans = pauseUnion(pauses, Number.POSITIVE_INFINITY).filter((s) => s.end > phaseStart);
  let cursor = phaseStart;
  let remaining = targetEffectiveMs;
  for (const s of spans) {
    const start = Math.max(s.start, phaseStart);
    const runnable = start - cursor;
    if (runnable >= remaining) return cursor + remaining;
    remaining -= Math.max(0, runnable);
    if (!Number.isFinite(s.end)) return null;
    cursor = Math.max(cursor, s.end);
  }
  return cursor + remaining;
}

/** Start of the currently running (un-paused) clock segment, or null if paused. */
export function runningSince(pauses: readonly PauseInterval[], phaseStart: number, now: number): number | null {
  if (hasOpenPause(pauses)) return null;
  let since = phaseStart;
  for (const s of pauseUnion(pauses, now)) {
    if (s.end <= now && s.end > since) since = s.end;
  }
  return since;
}

const headStartPauses = (r: RoundDoc) => r.pauses.filter((p) => p.phase === 'HEAD_START');
const chasePauses = (r: RoundDoc) => r.pauses.filter((p) => p.phase === 'CHASE');

/** Wall time at which the chase phase begins (nominal, pause-adjusted). */
export function chaseStartDeadline(r: RoundDoc): number | null {
  if (r.chaseStartAt !== null) return r.chaseStartAt;
  if (r.roundStartAt === null) return null;
  return wallTimeForEffective(headStartPauses(r), r.roundStartAt, r.rules.headStartSeconds * 1000);
}

export function effectiveHeadStartMs(r: RoundDoc, now: number): number {
  if (r.roundStartAt === null) return 0;
  const end = r.chaseStartAt ?? now;
  return Math.min(effectiveElapsedMs(headStartPauses(r), r.roundStartAt, Math.min(now, end)), r.rules.headStartSeconds * 1000);
}

export function effectiveChaseMs(r: RoundDoc, at: number): number {
  if (r.chaseStartAt === null) return 0;
  return effectiveElapsedMs(chasePauses(r), r.chaseStartAt, at);
}

/** Wall time when ping `index` is due (index 0 = chase start). */
export function pingDeadline(r: RoundDoc, index: number): number | null {
  if (r.chaseStartAt === null) return index === 0 ? chaseStartDeadline(r) : null;
  return wallTimeForEffective(chasePauses(r), r.chaseStartAt, index * r.rules.pingIntervalSeconds * 1000);
}

/** Wall time when the optional chase cap is reached. */
export function timeCapDeadline(r: RoundDoc): number | null {
  if (r.rules.maxChaseSeconds === null || r.chaseStartAt === null) return null;
  return wallTimeForEffective(chasePauses(r), r.chaseStartAt, r.rules.maxChaseSeconds * 1000);
}

export function totalPauseMs(r: RoundDoc, until: number): number {
  if (r.roundStartAt === null) return 0;
  return pausedOverlapMs(r.pauses, r.roundStartAt, until);
}

/** Was wall time `t` inside any pause interval (capture-pending included)? */
export function isWithinPause(pauses: readonly PauseInterval[], t: number, openEnd: number): boolean {
  return pauseUnion(pauses, openEnd).some((s) => t >= s.start && t < s.end);
}
