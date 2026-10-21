import { hasOpenPause } from './clock.js';
import { hiderUids } from './crews.js';
import { applyChaseStart, applyClaimExpiry, applyLateRelease, applyPing, applyTimeCap, expirePauseRequest, nextDueEvent, type Transition } from './engine.js';
import { selectLateSample, selectPingSample } from './pingSelection.js';
import type { CaptureClaim, DomainEvent, GpsPoint, NotificationIntent, RoundDoc } from './types.js';

export interface TickDeps {
  /** Hiding-crew samples in [from, to] (window filtering is re-applied by the selectors). */
  hiderSamples: (from: number, to: number) => Promise<GpsPoint[]>;
  activeClaim: CaptureClaim | null;
}

export interface TickResult extends Transition {
  processed: { kind: string; at: number; pingIndex?: number }[];
  claimExpired: CaptureClaim | null;
}

/**
 * Release a waiting ping if the hiders' current position has reached the
 * server (ADR 0015). No-op (returns null) when nothing is waiting, the chase
 * is paused or under review, or no fresh fix qualifies yet.
 */
export async function tryLateRelease(round: RoundDoc, now: number, hiderSamples: TickDeps['hiderSamples']): Promise<Transition | null> {
  const w = round.waitingPing;
  if (!w || round.state !== 'CHASE' || hasOpenPause(round.pauses)) return null;
  const maxAgeMs = round.rules.maxPingGpsAgeSeconds * 1000;
  const candidates = await hiderSamples(Math.max(w.deadline, now - maxAgeMs) - 5 * 60_000, now);
  const sample = selectLateSample(candidates, {
    deadline: w.deadline,
    hiderUids: hiderUids(round),
    now,
    maxAgeSeconds: round.rules.maxPingGpsAgeSeconds,
    maxAccuracyMeters: round.rules.maxPingAccuracyMeters,
    pauses: round.pauses,
  });
  return sample ? applyLateRelease(round, sample, now) : null;
}

/**
 * Advance a round through every scheduled event that is due at `now`, in
 * chronological order, then try to release a waiting ping. Idempotent:
 * re-running with the same state and time is a no-op because each event mutates
 * the state it was derived from (nextPingIndex, state, claim). Safe under Cloud
 * Tasks retries and watchdog repair.
 */
export async function tickRound(round: RoundDoc, now: number, deps: TickDeps, maxEvents = 500): Promise<TickResult> {
  let r = round;
  const events: DomainEvent[] = [];
  const notifications: NotificationIntent[] = [];
  const processed: TickResult['processed'] = [];
  let claimExpired: CaptureClaim | null = null;

  for (let i = 0; i < maxEvents; i++) {
    const due = nextDueEvent(r, now);
    if (!due) break;
    let t: Transition;
    switch (due.kind) {
      case 'CHASE_START':
        t = applyChaseStart(r, due.at, now);
        break;
      case 'PING': {
        const maxAgeMs = r.rules.maxPingGpsAgeSeconds * 1000;
        // Spike checks look back up to 5 minutes before the eligibility window.
        const candidates = await deps.hiderSamples(due.at - maxAgeMs - 5 * 60_000, due.at);
        const sample = selectPingSample(candidates, {
          deadline: due.at,
          hiderUids: hiderUids(r),
          roundStartAt: r.roundStartAt!,
          maxAgeSeconds: r.rules.maxPingGpsAgeSeconds,
          maxAccuracyMeters: r.rules.maxPingAccuracyMeters,
          pauses: r.pauses,
        });
        t = applyPing(r, due.pingIndex, due.at, sample, now);
        break;
      }
      case 'TIME_CAP':
        t = applyTimeCap(r, due.at, now);
        break;
      case 'CLAIM_EXPIRY': {
        const claim = deps.activeClaim;
        if (!claim || claim.claimId !== r.activeClaimId) throw new Error('active claim missing for expiry');
        t = applyClaimExpiry(r, claim, now);
        claimExpired = claim;
        break;
      }
      case 'PAUSE_REQUEST_EXPIRY':
        t = expirePauseRequest(r, now);
        break;
    }
    processed.push({ kind: due.kind, at: due.at, ...(due.kind === 'PING' ? { pingIndex: due.pingIndex } : {}) });
    r = t.round;
    events.push(...t.events);
    notifications.push(...t.notifications);
  }
  const late = await tryLateRelease(r, now, deps.hiderSamples);
  if (late) {
    processed.push({ kind: 'LATE_PING', at: now, pingIndex: late.round.pings[late.round.pings.length - 1]!.index });
    r = late.round;
    events.push(...late.events);
    notifications.push(...late.notifications);
  }
  if (processed.length) {
    r = { ...r, lastTickAt: now };
  }
  return { round: r, events, notifications, processed, claimExpired };
}
