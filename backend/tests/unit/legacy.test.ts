import { describe, expect, it } from 'vitest';
import { crewOfUid, hiderUids, operatorUidsOf, roundUids, seekerUids } from '../../src/domain/crews.js';
import { upgradeRoundDoc, upgradeSessionDoc } from '../../src/domain/legacy.js';
import { buildScorecard } from '../../src/domain/scoring.js';
import type { RoundDoc, SessionDoc } from '../../src/domain/types.js';
import { HIDER, readyRound, SEEKER, session, T0 } from './fixtures.js';

/** A night as stored before crews (types at 21d5e2a^): one phone per crew, one seeking crew. */
const oldSession = () => ({
  id: 'old1',
  title: 'First night',
  scheduledDate: '2026-10-20',
  hostUid: HIDER,
  status: 'COMPLETED',
  rules: { headStartSeconds: 120, pingIntervalSeconds: 120, totalRounds: 2, initialHidingTeam: 'A', alternateRoles: true },
  teams: {
    A: { teamId: 'tA', key: 'A', name: 'Owls', color: '#f00', operatorUid: HIDER, operatorDisplayName: 'Morgan', roster: [{ personId: 'pAna', displayName: 'Ana' }] },
    B: { teamId: 'tB', key: 'B', name: 'Wolves', color: '#00f', operatorUid: null, operatorDisplayName: null, roster: [{ personId: 'pBo', displayName: 'Bo' }] },
  },
  memberUids: [HIDER, SEEKER],
  participantPersonIds: ['pAna', 'pBo'],
  roundBriefs: [
    { roundId: 'r1', index: 1, hidingTeam: 'A', outcome: 'CAUGHT', observedChaseSeconds: 300, isRightCensored: false, rulesFingerprint: 'f1' },
    { roundId: 'r2', index: 2, hidingTeam: 'B', outcome: 'TIMED_OUT', observedChaseSeconds: 600, isRightCensored: true, rulesFingerprint: 'f1' },
  ],
  revokedAt: null,
  createdAt: T0,
});

const oldRound = () => ({
  id: 'r1',
  sessionId: 'old1',
  index: 1,
  state: 'CAUGHT',
  hidingTeam: 'A',
  seekingTeam: 'B',
  hiderUid: HIDER,
  seekerUid: SEEKER,
  teamNames: { A: 'Owls', B: 'Wolves' },
  rosterSnapshot: { A: [{ personId: 'pAna', displayName: 'Ana' }], B: [{ personId: 'pBo', displayName: 'Bo' }] },
  pings: [{ index: 0, deadline: T0, releasedAt: T0, latitude: 39.74, longitude: -104.99, sourcePointId: 'pt1', status: 'RELEASED' }],
  result: {
    roundId: 'r1',
    roundIndex: 1,
    hidingTeam: 'A',
    seekingTeam: 'B',
    hidingTeamName: 'Owls',
    seekingTeamName: 'Wolves',
    hidingRosterSnapshot: [{ personId: 'pAna', displayName: 'Ana' }],
    seekingRosterSnapshot: [{ personId: 'pBo', displayName: 'Bo' }],
    outcome: 'CAUGHT',
    headStartSeconds: 120,
    observedChaseSeconds: 300,
    isRightCensored: false,
    hidingDistanceTotalMeters: 900,
    hidingDistanceChaseMeters: 500,
    seekingDistanceChaseMeters: 2100,
    gpsCoverageFractionHider: 0.9,
    gpsCoverageFractionSeeker: 0.8,
    routeQualityHider: 'GOOD',
    routeQualitySeeker: 'ESTIMATED',
    rulesFingerprint: 'f1',
  },
});

describe('nights recorded before crews', () => {
  it('a session gets crew phone lists from its one operator per crew, and briefs gain the other crew as seekers', () => {
    const s = upgradeSessionDoc(oldSession()) as unknown as SessionDoc;
    expect(s.teams.A!.operatorUids).toEqual([HIDER]);
    expect(s.teams.B!.operatorUids).toEqual([]);
    expect(crewOfUid(s, HIDER)).toBe('A');
    expect(crewOfUid(s, SEEKER)).toBeNull();
    expect(operatorUidsOf(s)).toEqual([HIDER]);
    expect(s.joinCode).toBeNull();
    expect(s.roundBriefs[0]).toMatchObject({ seekingTeams: ['B'], seekMode: 'TOGETHER', catchCreditTeams: ['B'], hidingRosterFingerprint: '' });
    // Credit is attribution for a catch only.
    expect(s.roundBriefs[1]).toMatchObject({ hidingTeam: 'B', seekingTeams: ['A'], catchCreditTeams: [] });
  });

  it("a round's snapshot comes from its own frozen hider and seeker phones", () => {
    const r = upgradeRoundDoc(oldRound()) as unknown as RoundDoc;
    expect(r.seekingTeams).toEqual(['B']);
    expect(r.operatorsByTeam).toEqual({ A: [HIDER], B: [SEEKER] });
    expect(hiderUids(r)).toEqual([HIDER]);
    expect(seekerUids(r)).toEqual([SEEKER]);
    expect(roundUids(r)).toEqual([HIDER, SEEKER]);
    expect(r.routeSourceUids).toEqual({ A: HIDER, B: SEEKER });
    expect(r.waitingPing).toBeNull();
    // An unrecorded pin source is null, which deletion reads as "the lone hider phone".
    expect(r.pings[0]!.sourceUid).toBeNull();

    const noSeeker = upgradeRoundDoc({ ...oldRound(), seekerUid: null }) as unknown as RoundDoc;
    expect(noSeeker.operatorsByTeam).toEqual({ A: [HIDER], B: [] });
  });

  it('a round result becomes per-crew: names, rosters, distances and catch credit', () => {
    const r = upgradeRoundDoc(oldRound()) as unknown as RoundDoc;
    expect(r.result).toMatchObject({
      seekingTeams: ['B'],
      seekMode: 'TOGETHER',
      teamNames: { A: 'Owls', B: 'Wolves' },
      rosterSnapshot: { A: [{ personId: 'pAna' }], B: [{ personId: 'pBo' }] },
      catchCreditTeams: ['B'],
      crews: {
        A: { role: 'HIDING', distanceTotalMeters: 900, distanceChaseMeters: 500, gpsCoverageFraction: 0.9, routeQuality: 'GOOD', phones: 1 },
        B: { role: 'SEEKING', distanceTotalMeters: null, distanceChaseMeters: 2100, gpsCoverageFraction: 0.8, routeQuality: 'ESTIMATED', phones: 1 },
      },
    });
    const timedOut = upgradeRoundDoc({ ...oldRound(), result: { ...oldRound().result, outcome: 'TIMED_OUT' } }) as unknown as RoundDoc;
    expect(timedOut.result!.catchCreditTeams).toEqual([]);
    // The upgraded results feed the scorecard like any other night's. Only the Owls hid, so nothing is compared.
    const sc = buildScorecard(upgradeSessionDoc(oldSession()) as unknown as SessionDoc, [r.result!]);
    expect(Object.keys(sc.teams)).toEqual(['A', 'B']);
    expect(sc.teams.A).toMatchObject({ name: 'Owls' });
    expect(sc.comparison.status).toBe('INSUFFICIENT');
    expect(sc.comparison.strongerHidingTeam).toBeNull();
  });

  it('current-shape and partial documents pass through unchanged', () => {
    const s = session();
    expect(upgradeSessionDoc(s as never)).toBe(s);
    const { round } = readyRound();
    expect(upgradeRoundDoc(round as never)).toBe(round);
    const projection = { memberUids: [HIDER] };
    expect(upgradeSessionDoc(projection)).toBe(projection);
    expect(upgradeRoundDoc(projection)).toBe(projection);
  });
});
