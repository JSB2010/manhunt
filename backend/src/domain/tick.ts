import { applyChaseStart, applyClaimExpiry, applyPing, applyTimeCap, expirePauseRequest, nextDueEvent, type Transition } from './engine.js';
import { selectPingSample } from './pingSelection.js';
import type { CaptureClaim, DomainEvent, GpsPoint, NotificationIntent, RoundDoc } from './types.js';

export interface TickDeps {
  /** Candidate hider samples around a deadline (window filtering is re-applied by selectPingSample). */
  candidatesForDeadline: (deadline: number, maxAgeSeconds: number) => Promise<GpsPoint[]>;
  activeClaim: CaptureClaim | null;
}

export interface TickResult extends Transition {
  processed: { kind: string; at: number; pingIndex?: number }[];
  claimExpired: CaptureClaim | null;
}

/**
 * Advance a round through every scheduled event that is due at `now`, in
 * chronological order. Idempotent: re-running with the same state and time is a
 * no-op because each event mutates the state it was derived from (nextPingIndex,
 * state, claim). Safe under Cloud Tasks retries and watchdog repair.
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
        const candidates = await deps.candidatesForDeadline(due.at, r.rules.maxPingGpsAgeSeconds);
        const sample = selectPingSample(candidates, {
          deadline: due.at,
          hiderUid: r.hiderUid!,
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
  if (processed.length) {
    r = { ...r, lastTickAt: now };
  }
  return { round: r, events, notifications, processed, claimExpired };
}
