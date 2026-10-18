import { describe, expect, it } from 'vitest';
import { buildScorecard, compositionFingerprint, personAnalytics } from '../../src/domain/scoring.js';
import type { RoundResult } from '../../src/domain/types.js';
import { session } from './fixtures.js';

const s = session();
const result = (over: Partial<RoundResult>): RoundResult => ({
  roundId: `r${over.roundIndex}`,
  roundIndex: 1,
  hidingTeam: 'A',
  seekingTeam: 'B',
  hidingTeamName: 'Crew A',
  seekingTeamName: 'Crew B',
  hidingRosterSnapshot: s.teams.A.roster,
  seekingRosterSnapshot: s.teams.B.roster,
  outcome: 'CAUGHT',
  headStartSeconds: 600,
  observedChaseSeconds: 0,
  isRightCensored: false,
  officialFoundAt: 0,
  confirmedAt: 0,
  claimId: 'c',
  totalPauseSeconds: 0,
  roundElapsedSeconds: 0,
  pingSlots: 3,
  pingsReleased: 3,
  pingsMissing: 0,
  pingsDelayed: 0,
  hidingDistanceTotalMeters: 1000,
  hidingDistanceChaseMeters: 600,
  seekingDistanceChaseMeters: 5000,
  gpsCoverageFractionHider: 0.9,
  gpsCoverageFractionSeeker: 0.95,
  routeQualityHider: 'GOOD',
  routeQualitySeeker: 'GOOD',
  rulesFingerprint: 'same',
  abortedReason: null,
  resolvedByDispute: false,
  finalizedAt: 0,
  ...over,
});

const swap = (r: Partial<RoundResult>): Partial<RoundResult> => ({
  hidingTeam: 'B',
  seekingTeam: 'A',
  hidingTeamName: 'Crew B',
  seekingTeamName: 'Crew A',
  hidingRosterSnapshot: s.teams.B.roster,
  seekingRosterSnapshot: s.teams.A.roster,
  ...r,
});

describe('night scorecard (spec §6.4)', () => {
  it('A hides 26:00, B hides 18:00 with identical settings → A stronger, no round winner', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 26 * 60 }), result(swap({ roundIndex: 2, observedChaseSeconds: 18 * 60 }))]);
    expect(sc.teams.A.hideSurvivalAverageSeconds).toBe(1560);
    expect(sc.teams.B.seekCaptureAverageSeconds).toBe(1560);
    expect(sc.teams.B.hideSurvivalAverageSeconds).toBe(1080);
    expect(sc.teams.A.seekCaptureAverageSeconds).toBe(1080);
    expect(sc.comparison).toMatchObject({ status: 'COMPARABLE', strongerHidingTeam: 'A', marginSeconds: 480 });
    expect(JSON.stringify(sc)).not.toMatch(/"[a-zA-Z]*winner[a-zA-Z]*":/i); // no winner fields anywhere
  });

  it('unequal hide counts → provisional, no winner', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50 })), result({ roundIndex: 3, observedChaseSeconds: 80 })]);
    expect(sc.comparison.status).toBe('PROVISIONAL');
    expect(sc.comparison.reasons).toContain('UNEQUAL_HIDE_ROUNDS');
    expect(sc.comparison.strongerHidingTeam).toBeNull();
  });

  it('timed-out rounds are censored and block a declared stronger crew', () => {
    const sc = buildScorecard(s, [
      result({ roundIndex: 1, outcome: 'TIMED_OUT', isRightCensored: true, observedChaseSeconds: 3600 }),
      result(swap({ roundIndex: 2, observedChaseSeconds: 1200 })),
    ]);
    expect(sc.teams.A.uncaughtCount).toBe(1);
    expect(sc.teams.A.hideSurvivalAverageIncludesCensored).toBe(true);
    expect(sc.teams.A.caughtOnlyHideAverageSeconds).toBeNull();
    expect(sc.comparison.reasons).toContain('CENSORED_ROUNDS');
    expect(sc.comparison.strongerHidingTeam).toBeNull();
  });

  it('different rules or aborted rounds → provisional', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50, rulesFingerprint: 'other' }))]);
    expect(sc.comparison.reasons).toContain('RULES_DIFFER');
    const ab = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50 })), result({ roundIndex: 3, outcome: 'ABORTED' })]);
    expect(ab.comparison.reasons).toContain('ABORTED_ROUNDS');
    expect(ab.teams.A.hideRoundCount).toBe(1);
  });

  it('reports walking and driving distance separately', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50 }))]);
    expect(sc.teams.A.hiderFootMetersTotal).toBe(1000);
    expect(sc.teams.A.seekerVehicleMetersChase).toBe(5000);
  });
});

describe('person analytics (crew-attributed)', () => {
  it('tracks a person across nights on different crews with stable personIds', () => {
    const night1 = { session: { ...s, id: 's1', scheduledDate: '2026-10-10' }, results: [result({ roundIndex: 1, observedChaseSeconds: 1500 }), result(swap({ roundIndex: 2, observedChaseSeconds: 900 }))], operatorUidsByRound: {} };
    // Night 2: Casey moved to the other crew
    const rosterA2 = [{ personId: 'p-morgan', displayName: 'Morgan' }, { personId: 'p-jules', displayName: 'Jules' }];
    const rosterB2 = [{ personId: 'p-taylor', displayName: 'Taylor' }, { personId: 'p-casey', displayName: 'Case' }];
    const night2 = {
      session: { ...s, id: 's2', scheduledDate: '2026-10-17' },
      results: [
        result({ roundIndex: 1, observedChaseSeconds: 600, hidingRosterSnapshot: rosterA2, seekingRosterSnapshot: rosterB2 }),
        result(swap({ roundIndex: 2, observedChaseSeconds: 1200, hidingRosterSnapshot: rosterB2, seekingRosterSnapshot: rosterA2 })),
      ],
      operatorUidsByRound: {},
    };
    const a = personAnalytics(new Set(['p-casey']), null, [night1, night2]);
    expect(a.attribution).toBe('CREW_LEVEL');
    expect(a.sessionsPlayed).toBe(2);
    expect(a.roundsCrewHid).toBe(2);
    expect(a.crewHideSurvival.averageSeconds).toBe(Math.round((1500 + 1200) / 2));
    expect(a.compositions.length).toBe(2);
    expect(a.pairedNights.stronger).toBe(2); // Crew A stronger night 1, Casey's crew B stronger night 2
    expect(a.coPlayers.find((c) => c.personId === 'p-morgan')?.sessionsTogether).toBe(1);
    expect(a.sampleNote).toMatch(/Small sample/);
    expect(a.operatorRounds).toBeNull();
  });

  it('composition fingerprints ignore order', () => {
    expect(compositionFingerprint([{ personId: 'a', displayName: '' }, { personId: 'b', displayName: '' }])).toBe(
      compositionFingerprint([{ personId: 'b', displayName: '' }, { personId: 'a', displayName: '' }]),
    );
  });
});
