import { describe, expect, it } from 'vitest';
import { buildScorecard, compositionFingerprint, personAnalytics } from '../../src/domain/scoring.js';
import type { RoundResult } from '../../src/domain/types.js';
import { session } from './fixtures.js';

const s = session();
const s3 = session({}, { three: true });
const rosters = { A: s3.teams.A!.roster, B: s3.teams.B!.roster, C: s3.teams.C!.roster };
const names = { A: 'Crew A', B: 'Crew B', C: 'Crew C' };

const crew = (role: 'HIDING' | 'SEEKING', meters: number, coverage = 0.9) => ({
  role,
  distanceTotalMeters: role === 'HIDING' ? meters : null,
  distanceChaseMeters: role === 'HIDING' ? Math.round(meters * 0.6) : meters,
  gpsCoverageFraction: coverage,
  routeQuality: 'GOOD' as const,
  phones: 1,
});

/** A two-crew round: `hidingTeam` hides, the other seeks. */
const result = (over: Partial<RoundResult>): RoundResult => {
  const hidingTeam = over.hidingTeam ?? 'A';
  const seekingTeams = over.seekingTeams ?? [hidingTeam === 'A' ? 'B' : 'A'];
  return {
    roundId: `r${over.roundIndex}`,
    roundIndex: 1,
    hidingTeam,
    seekingTeams,
    seekMode: 'TOGETHER',
    teamNames: Object.fromEntries([hidingTeam, ...seekingTeams].map((k) => [k, names[k]])),
    rosterSnapshot: Object.fromEntries([hidingTeam, ...seekingTeams].map((k) => [k, rosters[k]])),
    catchCreditTeams: over.outcome && over.outcome !== 'CAUGHT' ? [] : seekingTeams,
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
    crews: Object.fromEntries([[hidingTeam, crew('HIDING', 1000)], ...seekingTeams.map((k) => [k, crew('SEEKING', 5000, 0.95)])]),
    rulesFingerprint: 'same',
    abortedReason: null,
    resolvedByDispute: false,
    finalizedAt: 0,
    ...over,
  };
};

const swap = (r: Partial<RoundResult>): Partial<RoundResult> => ({ hidingTeam: 'B', seekingTeams: ['A'], ...r });

describe('night scorecard (spec §6.4)', () => {
  it('A hides 26:00, B hides 18:00 with identical settings → A stronger, no round winner', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 26 * 60 }), result(swap({ roundIndex: 2, observedChaseSeconds: 18 * 60 }))]);
    expect(sc.teams.A!.hideSurvivalAverageSeconds).toBe(1560);
    expect(sc.teams.B!.seekCaptureAverageSeconds).toBe(1560);
    expect(sc.teams.B!.hideSurvivalAverageSeconds).toBe(1080);
    expect(sc.teams.A!.seekCaptureAverageSeconds).toBe(1080);
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
    expect(sc.teams.A!.uncaughtCount).toBe(1);
    expect(sc.teams.A!.hideSurvivalAverageIncludesCensored).toBe(true);
    expect(sc.teams.A!.caughtOnlyHideAverageSeconds).toBeNull();
    expect(sc.comparison.reasons).toContain('CENSORED_ROUNDS');
    expect(sc.comparison.strongerHidingTeam).toBeNull();
  });

  it('different rules or aborted rounds → provisional', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50, rulesFingerprint: 'other' }))]);
    expect(sc.comparison.reasons).toContain('RULES_DIFFER');
    const ab = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50 })), result({ roundIndex: 3, outcome: 'ABORTED' })]);
    expect(ab.comparison.reasons).toContain('ABORTED_ROUNDS');
    expect(ab.teams.A!.hideRoundCount).toBe(1);
  });

  it('reports walking and driving distance separately', () => {
    const sc = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 100 }), result(swap({ roundIndex: 2, observedChaseSeconds: 50 }))]);
    expect(sc.teams.A!.hiderFootMetersTotal).toBe(1000);
    expect(sc.teams.A!.seekerVehicleMetersChase).toBe(5000);
  });
});

describe('three crews and open nights', () => {
  const three = (over: Partial<RoundResult>) => {
    const h = over.hidingTeam ?? 'A';
    return result({ seekingTeams: (['A', 'B', 'C'] as const).filter((k) => k !== h), ...over });
  };

  it('compares three crews once each hid equally often', () => {
    const sc = buildScorecard(s3, [
      three({ roundIndex: 1, hidingTeam: 'A', observedChaseSeconds: 900 }),
      three({ roundIndex: 2, hidingTeam: 'B', observedChaseSeconds: 1500 }),
      three({ roundIndex: 3, hidingTeam: 'C', observedChaseSeconds: 1200 }),
    ]);
    expect(sc.comparison).toMatchObject({ status: 'COMPARABLE', strongerHidingTeam: 'B', marginSeconds: 300 });
    expect(sc.teams.C!.seekRoundCount).toBe(2);
  });

  it('a crew that never hid makes the night insufficient', () => {
    const sc = buildScorecard(s3, [three({ roundIndex: 1, hidingTeam: 'A', observedChaseSeconds: 900 }), three({ roundIndex: 2, hidingTeam: 'B', observedChaseSeconds: 1500 })]);
    expect(sc.comparison).toMatchObject({ status: 'INSUFFICIENT', strongerHidingTeam: null });
  });

  it('RACE credits only the catching crew; the other is "caught by another crew", not a miss', () => {
    const sc = buildScorecard(s3, [three({ roundIndex: 1, hidingTeam: 'A', seekMode: 'RACE', catchCreditTeams: ['C'], observedChaseSeconds: 900 })]);
    expect(sc.teams.C!).toMatchObject({ seekCreditedCatches: 1, seekCaptureAverageSeconds: 900, seekCaughtByOtherCrew: 0 });
    expect(sc.teams.B!).toMatchObject({ seekCreditedCatches: 0, seekCaptureAverageSeconds: null, seekCaughtByOtherCrew: 1, seekUncaughtCount: 0 });
  });

  it('a crew hiding with different people across its hiding rounds is provisional', () => {
    const moved = [...rosters.A, { personId: 'p-new', displayName: 'New' }];
    const sc = buildScorecard(s, [
      result({ roundIndex: 1, observedChaseSeconds: 100 }),
      result(swap({ roundIndex: 2, observedChaseSeconds: 50 })),
      result({ roundIndex: 3, observedChaseSeconds: 80, rosterSnapshot: { A: moved, B: rosters.B } }),
      result(swap({ roundIndex: 4, observedChaseSeconds: 60 })),
    ]);
    expect(sc.comparison.reasons).toEqual(['ROSTERS_CHANGED']);
  });

  it('a crew that changed while seeking makes the night provisional too (ADR 0019)', () => {
    // Crew A hid from B + X; then B hid from A without X. Different seekers: not a fair comparison.
    const seekOnly = buildScorecard(s, [
      result({ roundIndex: 1, observedChaseSeconds: 100, rosterSnapshot: { A: rosters.A, B: [...rosters.B, { personId: 'p-x', displayName: 'X' }] } }),
      result(swap({ roundIndex: 2, observedChaseSeconds: 50 })),
    ]);
    expect(seekOnly.comparison).toMatchObject({ status: 'PROVISIONAL', reasons: ['ROSTERS_CHANGED'] });
    // Each round is its own matchup, and neither can name a stronger crew.
    expect(seekOnly.matchups.map((m) => m.rounds)).toEqual([[1], [2]]);
    expect(seekOnly.matchups.every((m) => m.comparison.status === 'INSUFFICIENT')).toBe(true);
  });

  it('keeps a removed crew in the scorecard by its round names', () => {
    const sc = buildScorecard(s, [three({ roundIndex: 1, hidingTeam: 'C', observedChaseSeconds: 300 })]);
    expect(sc.teams.C!.name).toBe('Crew C');
    expect(sc.teams.C!.hideRoundCount).toBe(1);
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
        result({ roundIndex: 1, observedChaseSeconds: 600, rosterSnapshot: { A: rosterA2, B: rosterB2 } }),
        result(swap({ roundIndex: 2, observedChaseSeconds: 1200, rosterSnapshot: { A: rosterA2, B: rosterB2 } })),
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

describe('crews that change during the night (ADR 0019)', () => {
  // Morgan, Casey & Jules vs Taylor, Riley & Sam; then Jules and Sam swap.
  const swapped = { A: [rosters.A[0]!, rosters.A[1]!, rosters.B[2]!], B: [rosters.B[0]!, rosters.B[1]!, rosters.A[2]!] };
  const night = [
    result({ roundIndex: 1, observedChaseSeconds: 600 }),
    result(swap({ roundIndex: 2, observedChaseSeconds: 300 })),
    result({ roundIndex: 3, observedChaseSeconds: 900, rosterSnapshot: swapped, teamNames: { A: 'Morgan, Casey & Sam', B: 'Taylor, Riley & Jules' } }),
    result(swap({ roundIndex: 4, observedChaseSeconds: 450, rosterSnapshot: swapped, teamNames: { A: 'Morgan, Casey & Sam', B: 'Taylor, Riley & Jules' } })),
  ];

  it('compares crews only within a matchup: the same people on each crew, the same rules', () => {
    const sc = buildScorecard(s, night);
    expect(sc.comparison).toMatchObject({ status: 'PROVISIONAL', reasons: ['ROSTERS_CHANGED'] });
    expect(sc.matchups.map((m) => m.rounds)).toEqual([[1, 2], [3, 4]]);
    const [first, second] = sc.matchups;
    expect(first!.comparison).toMatchObject({ status: 'COMPARABLE', strongerHidingTeam: 'A', marginSeconds: 300 });
    expect(second!.comparison).toMatchObject({ status: 'COMPARABLE', strongerHidingTeam: 'A', marginSeconds: 450 });
    expect(second!.crews.map((c) => [c.team, c.name, c.people.map((p) => p.displayName), c.hideRounds, c.hideAverageSeconds, c.catches])).toEqual([
      ['A', 'Morgan, Casey & Sam', ['Morgan', 'Casey', 'Sam'], 1, 900, 1],
      ['B', 'Taylor, Riley & Jules', ['Taylor', 'Riley', 'Jules'], 1, 450, 1],
    ]);
    expect(second!.crews.map((c) => [c.hiderFootMeters, c.seekerVehicleMeters])).toEqual([[1000, 5000], [1000, 5000]]);
  });

  it('the same people under swapped colours are the same matchup; a rules change starts a new one', () => {
    const colours = buildScorecard(s, [
      result({ roundIndex: 1, observedChaseSeconds: 600 }),
      // Crew A's people now play as B, and B's as A: still the same two crews.
      result({ roundIndex: 2, hidingTeam: 'A', seekingTeams: ['B'], observedChaseSeconds: 300, rosterSnapshot: { A: rosters.B, B: rosters.A } }),
    ]);
    expect(colours.matchups).toHaveLength(1);
    expect(colours.matchups[0]!.crews.map((c) => [c.team, c.hideRounds, c.seekRounds])).toEqual([['A', 1, 1], ['B', 1, 1]]);
    const rules = buildScorecard(s, [result({ roundIndex: 1, observedChaseSeconds: 600 }), result(swap({ roundIndex: 2, observedChaseSeconds: 300, rulesFingerprint: 'shorter' }))]);
    expect(rules.matchups.map((m) => m.rounds)).toEqual([[1], [2]]);
  });

  it('tallies each person by the rounds their crew hid and sought (crew-level)', () => {
    const sc = buildScorecard(s, night);
    const by = Object.fromEntries(sc.people.map((p) => [p.displayName, [p.roundsHid, p.roundsSought, p.hideAverageSeconds, p.catches]]));
    expect(by.Morgan).toEqual([2, 2, 750, 2]);
    expect(by.Jules).toEqual([2, 2, 525, 2]); // hid with A in round 1 and with B in round 4
    expect(by.Sam).toEqual([2, 2, 600, 2]);
  });

  it('says what changed before each round: people and rules', () => {
    const sc = buildScorecard(s, night, {
      r1: { ...s.rules },
      r2: { ...s.rules },
      r3: { ...s.rules, headStartSeconds: 300 },
      r4: { ...s.rules, headStartSeconds: 300 },
    });
    expect(sc.changes.map((c) => c.roundIndex)).toEqual([2, 3, 4]);
    expect(sc.changes[0]).toEqual({ roundIndex: 2, joined: [], left: [], moved: [], rules: [] });
    expect(sc.changes[1]).toEqual({
      roundIndex: 3,
      joined: [],
      left: [],
      moved: [{ name: 'Sam', from: 'B', to: 'A' }, { name: 'Jules', from: 'A', to: 'B' }],
      rules: [{ field: 'headStartSeconds', from: s.rules.headStartSeconds, to: 300 }],
    });
    // Someone arriving, someone leaving.
    const late = buildScorecard(s, [result({ roundIndex: 1 }), result(swap({ roundIndex: 2, rosterSnapshot: { A: [...rosters.A, { personId: 'p-ezra', displayName: 'Ezra' }], B: rosters.B.slice(0, 2) } }))]);
    expect(late.changes[0]).toMatchObject({ joined: ['Ezra'], left: ['Sam'], moved: [] });
  });
});
