import { createHash } from 'node:crypto';
import type { PersonRef, RoundResult, SessionDoc, TeamKey } from './types.js';

/**
 * Night scorecard and cross-night analytics (spec §6).
 *
 * - There is never a single-round winner.
 * - Hide survival is computed only over rounds a crew hid; timed-out rounds are
 *   right-censored (observed >= cap) and flagged, never presented as a catch.
 * - A night comparison names a stronger hiding crew only when the comparison is
 *   balanced (equal valid hide rounds, identical rules, no censored/aborted rounds).
 * - Person-level stats are always crew-attributed.
 */

export interface TeamScore {
  team: TeamKey;
  name: string;
  hideRoundCount: number;
  abortedHideRounds: number;
  caughtCount: number;
  uncaughtCount: number;
  hideSurvivalTotalSeconds: number;
  hideSurvivalAverageSeconds: number | null;
  hideSurvivalAverageIncludesCensored: boolean;
  caughtOnlyHideAverageSeconds: number | null;
  seekRoundCount: number;
  seekCaptureAverageSeconds: number | null;
  seekUncaughtCount: number;
  hiderFootMetersTotal: number;
  hiderFootMetersChase: number;
  seekerVehicleMetersChase: number;
  meanHiderCoverage: number | null;
  meanSeekerCoverage: number | null;
}

export type ComparisonStatus = 'COMPARABLE' | 'PROVISIONAL' | 'INSUFFICIENT';

export interface NightComparison {
  status: ComparisonStatus;
  strongerHidingTeam: TeamKey | null;
  marginSeconds: number | null;
  reasons: string[];
  explanation: string;
}

export interface Scorecard {
  teams: Record<TeamKey, TeamScore>;
  comparison: NightComparison;
  rulesConsistent: boolean;
  rounds: RoundResult[];
  trend: { roundIndex: number; hidingTeam: TeamKey; observedChaseSeconds: number; isRightCensored: boolean; outcome: RoundResult['outcome'] }[];
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0));
const meanOrNull = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
};

function teamScore(team: TeamKey, name: string, results: RoundResult[]): TeamScore {
  const hid = results.filter((r) => r.hidingTeam === team);
  const validHid = hid.filter((r) => r.outcome !== 'ABORTED');
  const caught = validHid.filter((r) => r.outcome === 'CAUGHT');
  const sought = results.filter((r) => r.seekingTeam === team && r.outcome !== 'ABORTED');
  const soughtCaught = sought.filter((r) => r.outcome === 'CAUGHT');
  return {
    team,
    name,
    hideRoundCount: validHid.length,
    abortedHideRounds: hid.length - validHid.length,
    caughtCount: caught.length,
    uncaughtCount: validHid.filter((r) => r.outcome === 'TIMED_OUT').length,
    hideSurvivalTotalSeconds: sum(validHid.map((r) => r.observedChaseSeconds)),
    hideSurvivalAverageSeconds: avg(validHid.map((r) => r.observedChaseSeconds)),
    hideSurvivalAverageIncludesCensored: validHid.some((r) => r.isRightCensored),
    caughtOnlyHideAverageSeconds: avg(caught.map((r) => r.observedChaseSeconds)),
    seekRoundCount: sought.length,
    seekCaptureAverageSeconds: avg(soughtCaught.map((r) => r.observedChaseSeconds)),
    seekUncaughtCount: sought.length - soughtCaught.length,
    hiderFootMetersTotal: sum(validHid.map((r) => r.hidingDistanceTotalMeters)),
    hiderFootMetersChase: sum(validHid.map((r) => r.hidingDistanceChaseMeters)),
    seekerVehicleMetersChase: sum(sought.map((r) => r.seekingDistanceChaseMeters)),
    meanHiderCoverage: meanOrNull(validHid.map((r) => r.gpsCoverageFractionHider)),
    meanSeekerCoverage: meanOrNull(sought.map((r) => r.gpsCoverageFractionSeeker)),
  };
}

export function compareNight(teams: Record<TeamKey, TeamScore>, results: RoundResult[]): NightComparison {
  const valid = results.filter((r) => r.outcome !== 'ABORTED');
  const reasons: string[] = [];
  if (teams.A.hideRoundCount === 0 || teams.B.hideRoundCount === 0) {
    return {
      status: 'INSUFFICIENT',
      strongerHidingTeam: null,
      marginSeconds: null,
      reasons: ['BOTH_CREWS_MUST_HIDE'],
      explanation: 'Each crew needs at least one valid hiding round before crews can be compared.',
    };
  }
  if (teams.A.hideRoundCount !== teams.B.hideRoundCount) reasons.push('UNEQUAL_HIDE_ROUNDS');
  if (new Set(valid.map((r) => r.rulesFingerprint)).size > 1) reasons.push('RULES_DIFFER');
  if (valid.some((r) => r.isRightCensored)) reasons.push('CENSORED_ROUNDS');
  if (results.some((r) => r.outcome === 'ABORTED')) reasons.push('ABORTED_ROUNDS');
  const a = teams.A.hideSurvivalAverageSeconds ?? 0;
  const b = teams.B.hideSurvivalAverageSeconds ?? 0;
  if (reasons.length) {
    const text: Record<string, string> = {
      UNEQUAL_HIDE_ROUNDS: 'crews hid an unequal number of times',
      RULES_DIFFER: 'rules changed between rounds',
      CENSORED_ROUNDS: 'at least one round timed out (survival time is a lower bound)',
      ABORTED_ROUNDS: 'at least one round was aborted',
    };
    return {
      status: 'PROVISIONAL',
      strongerHidingTeam: null,
      marginSeconds: null,
      reasons,
      explanation: `Provisional comparison: ${reasons.map((r) => text[r]).join('; ')}. Descriptive statistics only — no stronger crew is declared.`,
    };
  }
  if (a === b) {
    return { status: 'COMPARABLE', strongerHidingTeam: null, marginSeconds: 0, reasons: ['TIED'], explanation: 'Both crews averaged the same survival time while hiding.' };
  }
  const stronger: TeamKey = a > b ? 'A' : 'B';
  return {
    status: 'COMPARABLE',
    strongerHidingTeam: stronger,
    marginSeconds: Math.abs(a - b),
    reasons: [],
    explanation: `${teams[stronger].name} survived longer on average while hiding (balanced night, identical rules). No individual round has a winner.`,
  };
}

export function buildScorecard(session: Pick<SessionDoc, 'teams'>, results: RoundResult[]): Scorecard {
  const sorted = [...results].sort((x, y) => x.roundIndex - y.roundIndex);
  const teams = { A: teamScore('A', session.teams.A.name, sorted), B: teamScore('B', session.teams.B.name, sorted) };
  const valid = sorted.filter((r) => r.outcome !== 'ABORTED');
  return {
    teams,
    comparison: compareNight(teams, sorted),
    rulesConsistent: new Set(valid.map((r) => r.rulesFingerprint)).size <= 1,
    rounds: sorted,
    trend: sorted.map((r) => ({
      roundIndex: r.roundIndex,
      hidingTeam: r.hidingTeam,
      observedChaseSeconds: r.observedChaseSeconds,
      isRightCensored: r.isRightCensored,
      outcome: r.outcome,
    })),
  };
}

// ---------------------------------------------------------------------------
// Cross-night analytics
// ---------------------------------------------------------------------------

export function compositionFingerprint(roster: readonly PersonRef[], resolve: (id: string) => string = (x) => x): string {
  const ids = [...new Set(roster.map((p) => resolve(p.personId)))].sort();
  return createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
}

export interface SessionResults {
  session: Pick<SessionDoc, 'id' | 'title' | 'scheduledDate' | 'teams'>;
  results: RoundResult[];
  operatorUidsByRound: Record<string, { hider: string | null; seeker: string | null }>;
}

export interface PersonAnalytics {
  personIds: string[];
  attribution: 'CREW_LEVEL';
  sessionsPlayed: number;
  roundsCrewHid: number;
  roundsCrewSought: number;
  crewHideSurvival: { rounds: number; averageSeconds: number | null; caught: number; censored: number; includesCensored: boolean };
  crewSeekCapture: { rounds: number; averageSeconds: number | null; uncaught: number };
  pairedNights: { stronger: number; weaker: number; tied: number; provisional: number; insufficient: number };
  compositions: { fingerprint: string; members: PersonRef[]; rounds: number; hideRounds: number; hideAverageSeconds: number | null; censoredHideRounds: number }[];
  coPlayers: { personId: string; displayName: string; sessionsTogether: number }[];
  operatorRounds: number | null;
  sessions: { sessionId: string; title: string; scheduledDate: string; crewNames: string[] }[];
  sampleNote: string;
}

/**
 * Crew-attributed statistics for a person (spec §2, §6.3). `personIds` are the
 * person's canonical id plus any merged duplicates. `linkedUid` (if the person
 * has an account) enables operator-instrumentation counts, labelled as such.
 */
export function personAnalytics(personIds: Set<string>, linkedUid: string | null, data: SessionResults[], resolve: (id: string) => string = (x) => x): PersonAnalytics {
  const inRoster = (roster: readonly PersonRef[]) => roster.some((p) => personIds.has(p.personId) || personIds.has(resolve(p.personId)));
  const hideTimes: number[] = [];
  let censored = 0;
  let caught = 0;
  const seekTimes: number[] = [];
  let seekRounds = 0;
  let uncaught = 0;
  let roundsHid = 0;
  let operatorRounds = 0;
  const paired = { stronger: 0, weaker: 0, tied: 0, provisional: 0, insufficient: 0 };
  const compositions = new Map<string, { members: PersonRef[]; rounds: number; hideTimes: number[]; censored: number; hideRounds: number }>();
  const coPlayers = new Map<string, { displayName: string; sessions: Set<string> }>();
  const sessions: PersonAnalytics['sessions'] = [];

  for (const { session, results, operatorUidsByRound } of data) {
    const valid = results.filter((r) => r.outcome !== 'ABORTED');
    let played = false;
    const crewNames = new Set<string>();
    const myCrewKeys = new Set<TeamKey>();
    for (const r of valid) {
      const hidRoster = r.hidingRosterSnapshot;
      const seekRoster = r.seekingRosterSnapshot;
      const onHiding = inRoster(hidRoster);
      const onSeeking = inRoster(seekRoster);
      if (!onHiding && !onSeeking) continue;
      played = true;
      const roster = onHiding ? hidRoster : seekRoster;
      crewNames.add(onHiding ? r.hidingTeamName : r.seekingTeamName);
      myCrewKeys.add(onHiding ? r.hidingTeam : r.seekingTeam);
      for (const p of roster) {
        if (personIds.has(p.personId) || personIds.has(resolve(p.personId))) continue;
        const key = resolve(p.personId);
        const cp = coPlayers.get(key) ?? { displayName: p.displayName, sessions: new Set<string>() };
        cp.sessions.add(session.id);
        coPlayers.set(key, cp);
      }
      const fp = compositionFingerprint(roster, resolve);
      const comp = compositions.get(fp) ?? { members: roster, rounds: 0, hideTimes: [], censored: 0, hideRounds: 0 };
      comp.rounds++;
      if (onHiding) {
        roundsHid++;
        hideTimes.push(r.observedChaseSeconds);
        comp.hideRounds++;
        comp.hideTimes.push(r.observedChaseSeconds);
        if (r.isRightCensored) {
          censored++;
          comp.censored++;
        } else caught++;
      } else {
        seekRounds++;
        if (r.outcome === 'CAUGHT') seekTimes.push(r.observedChaseSeconds);
        else uncaught++;
      }
      compositions.set(fp, comp);
      const ops = operatorUidsByRound[r.roundId];
      if (linkedUid && ops && (ops.hider === linkedUid || ops.seeker === linkedUid)) operatorRounds++;
    }
    if (!played) continue;
    sessions.push({ sessionId: session.id, title: session.title, scheduledDate: session.scheduledDate, crewNames: [...crewNames] });
    if (myCrewKeys.size === 1) {
      const myKey = [...myCrewKeys][0]!;
      const sc = buildScorecard(session, results);
      if (sc.comparison.status === 'INSUFFICIENT') paired.insufficient++;
      else if (sc.comparison.status === 'PROVISIONAL') paired.provisional++;
      else if (sc.comparison.strongerHidingTeam === null) paired.tied++;
      else if (sc.comparison.strongerHidingTeam === myKey) paired.stronger++;
      else paired.weaker++;
    } else {
      paired.provisional++; // person switched crews mid-night: no paired attribution
    }
  }

  const totalRounds = roundsHid + seekRounds;
  return {
    personIds: [...personIds],
    attribution: 'CREW_LEVEL',
    sessionsPlayed: sessions.length,
    roundsCrewHid: roundsHid,
    roundsCrewSought: seekRounds,
    crewHideSurvival: { rounds: roundsHid, averageSeconds: avg(hideTimes), caught, censored, includesCensored: censored > 0 },
    crewSeekCapture: { rounds: seekRounds, averageSeconds: avg(seekTimes), uncaught },
    pairedNights: paired,
    compositions: [...compositions.entries()]
      .map(([fingerprint, c]) => ({ fingerprint, members: c.members, rounds: c.rounds, hideRounds: c.hideRounds, hideAverageSeconds: avg(c.hideTimes), censoredHideRounds: c.censored }))
      .sort((a, b) => b.rounds - a.rounds),
    coPlayers: [...coPlayers.entries()]
      .map(([personId, c]) => ({ personId, displayName: c.displayName, sessionsTogether: c.sessions.size }))
      .sort((a, b) => b.sessionsTogether - a.sessionsTogether),
    operatorRounds: linkedUid ? operatorRounds : null,
    sessions: sessions.sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate)),
    sampleNote:
      totalRounds < 8
        ? `Small sample (${totalRounds} rounds). Figures are crew-level observations, not individual performance, and can change a lot with more nights.`
        : `Crew-level observational statistics over ${totalRounds} rounds. Correlation only — not individual performance.`,
  };
}
