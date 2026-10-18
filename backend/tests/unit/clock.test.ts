import { describe, expect, it } from 'vitest';
import { effectiveElapsedMs, pausedOverlapMs, pauseUnion, runningSince, wallTimeForEffective } from '../../src/domain/clock.js';
import type { PauseInterval } from '../../src/domain/types.js';

const P = (startAt: number, endAt: number | null, kind: PauseInterval['kind'] = 'MANUAL'): PauseInterval => ({
  id: `p${startAt}`,
  kind,
  startAt,
  endAt,
  phase: 'CHASE',
  requestedByUid: null,
  confirmedByUid: null,
  reason: null,
});

describe('pause-aware clock', () => {
  it('merges overlapping pauses into a union', () => {
    expect(pauseUnion([P(10, 20), P(15, 30), P(40, 50)], 100)).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 50 },
    ]);
  });

  it('counts overlapping pause time once', () => {
    expect(pausedOverlapMs([P(10, 20), P(15, 30)], 0, 100)).toBe(20);
    expect(pausedOverlapMs([P(10, null)], 0, 25)).toBe(15);
  });

  it('effective elapsed excludes pauses', () => {
    expect(effectiveElapsedMs([P(100, 200)], 0, 300)).toBe(200);
    expect(effectiveElapsedMs([], 0, 300)).toBe(300);
    expect(effectiveElapsedMs([P(100, null)], 0, 300)).toBe(100);
  });

  it('inverts effective time to wall time across pauses', () => {
    expect(wallTimeForEffective([], 0, 600)).toBe(600);
    expect(wallTimeForEffective([P(100, 200)], 0, 600)).toBe(700);
    expect(wallTimeForEffective([P(100, 200), P(150, 250)], 0, 600)).toBe(750);
    // target falls before the pause: unaffected
    expect(wallTimeForEffective([P(1000, 2000)], 0, 600)).toBe(600);
  });

  it('returns null while an open pause blocks the deadline', () => {
    expect(wallTimeForEffective([P(100, null)], 0, 600)).toBeNull();
    // ...but a deadline before the open pause is still known
    expect(wallTimeForEffective([P(700, null)], 0, 600)).toBe(600);
  });

  it('is consistent: effective(wallTimeForEffective(x)) === x', () => {
    const pauses = [P(50, 80), P(300, 420), P(410, 500)];
    for (const target of [0, 10, 49, 50, 51, 200, 400, 1000]) {
      const wall = wallTimeForEffective(pauses, 0, target)!;
      expect(effectiveElapsedMs(pauses, 0, wall)).toBe(target);
    }
  });

  it('reports the running segment start', () => {
    expect(runningSince([P(100, 200)], 0, 300)).toBe(200);
    expect(runningSince([], 0, 300)).toBe(0);
    expect(runningSince([P(100, null)], 0, 300)).toBeNull();
  });
});
