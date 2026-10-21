import { createHash } from 'node:crypto';
import { rosterFingerprint } from './crews.js';
import { TEAM_KEYS, type PersonRef, type RoundResult, type SessionDoc, type TeamKey } from './types.js';

/**
 * Night scorecard and cross-night analytics (spec §6).
 *
 * - There is never a single-round winner. Catch credit (`catchCreditTeams`) is
 *   attribution only: RACE credits the claimant's crew, TOGETHER every seeking crew.
 * - Hide survival is computed only over rounds a crew hid; timed-out rounds are
 *   right-censored (observed >= cap) and flagged, never presented as a catch.
 * - A night comparison names a stronger hiding crew only when the comparison is
 *   balanced (every crew hid equally often, identical rules, the same roster in
 *   each crew's own hiding rounds, no censored/aborted rounds).
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
  /** rounds this crew sought that ended in a catch credited to it */
  seekCreditedCatches: number;
  seekCaptureAverageSeconds: number | null;
  seekUncaughtCount: number;
  /** RACE rounds where the other seeking crew made the catch */
  seekCaughtByOtherCrew: number;
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
  /** lead over the runner-up crew */
  marginSeconds: number | null;
  reasons: string[];
  explanation: string;
}

export interface Scorecard {
  teams: Partial<Record<TeamKey, TeamScore>>;
  comparison: NightComparison;
  rulesConsistent: boolean;
  rounds: RoundResult[];
  trend: { roundIndex: number; hidingTeam: TeamKey; observedChaseSeconds: number; isRightCensored: boolean; outcome: RoundResult['outcome'] }[];
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const sum = (xs: (number | null | undefined)[]) => Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0));
const meanOrNull = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x !== null && x !== undefined);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
};

function teamScore(team: TeamKey, name: string, results: RoundResult[]): TeamScore {
  const hid = results.filter((r) => r.hidingTeam === team);
  const validHid = hid.filter((r) => r.outcome !== 'ABORTED');
  const caught = validHid.filter((r) => r.outcome === 'CAUGHT');
  const sought = results.filter((r) => r.seekingTeams.includes(team) && r.outcome !== 'ABORTED');
  const credited = sought.filter((r) => r.outcome === 'CAUGHT' && r.catchCreditTeams.includes(team));
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
    seekCreditedCatches: credited.length,
    seekCaptureAverageSeconds: avg(credited.map((r) => r.observedChaseSeconds)),
    seekUncaughtCount: sought.filter((r) => r.outcome !== 'CAUGHT').length,
    seekCaughtByOtherCrew: sought.filter((r) => r.outcome === 'CAUGHT' && !r.catchCreditTeams.includes(team)).length,
    hiderFootMetersTotal: sum(validHid.map((r) => r.crews[team]?.distanceTotalMeters)),
    hiderFootMetersChase: sum(validHid.map((r) => r.crews[team]?.distanceChaseMeters)),
    seekerVehicleMetersChase: sum(sought.map((r) => r.crews[team]?.distanceChaseMeters)),
    meanHiderCoverage: meanOrNull(validHid.map((r) => r.crews[team]?.gpsCoverageFraction)),
    meanSeekerCoverage: meanOrNull(sought.map((r) => r.crews[team]?.gpsCoverageFraction)),
  };
}

/** Crews that played at least one non-aborted round, in key order. */
function playingCrews(results: RoundResult[]): TeamKey[] {
  const seen = new Set<TeamKey>();
  for (const r of results) {
    if (r.outcome === 'ABORTED') continue;
    seen.add(r.hidingTeam);
    for (const k of r.seekingTeams) seen.add(k);
  }
  return TEAM_KEYS.filter((k) => seen.has(k));
}

/** True when some crew hid with different rosters across its own hiding rounds. */
function rostersChanged(valid: RoundResult[]): boolean {
  const byCrew = new Map<TeamKey, Set<string>>();
  for (const r of valid) {
    const set = byCrew.get(r.hidingTeam) ?? new Set<string>();
    set.add(rosterFingerprint(r.rosterSnapshot[r.hidingTeam]));
    byCrew.set(r.hidingTeam, set);
  }
  return [...byCrew.values()].some((s) => s.size > 1);
}

const REASON_TEXT: Record<string, string> = {
  UNEQUAL_HIDE_ROUNDS: 'crews hid an unequal number of times',
  RULES_DIFFER: 'rules changed between rounds',
  ROSTERS_CHANGED: 'a crew hid with different people',
  CENSORED_ROUNDS: 'a round timed out',
  ABORTED_ROUNDS: 'a round was aborted',
};

export function compareNight(teams: Partial<Record<TeamKey, TeamScore>>, results: RoundResult[]): NightComparison {
  const valid = results.filter((r) => r.outcome !== 'ABORTED');
  const crews = playingCrews(results);
  const scores = crews.map((k) => teams[k]).filter((t): t is TeamScore => !!t);
  if (scores.length < 2 || scores.some((t) => t.hideRoundCount === 0)) {
    return {
      status: 'INSUFFICIENT',
      strongerHidingTeam: null,
      marginSeconds: null,
      reasons: ['EVERY_CREW_MUST_HIDE'],
      explanation: 'Every crew needs a hiding round before crews can be compared.',
    };
  }
  const reasons: string[] = [];
  if (new Set(scores.map((t) => t.hideRoundCount)).size > 1) reasons.push('UNEQUAL_HIDE_ROUNDS');
  if (new Set(valid.map((r) => r.rulesFingerprint)).size > 1) reasons.push('RULES_DIFFER');
  if (rostersChanged(valid)) reasons.push('ROSTERS_CHANGED');
  if (valid.some((r) => r.isRightCensored)) reasons.push('CENSORED_ROUNDS');
  if (results.some((r) => r.outcome === 'ABORTED')) reasons.push('ABORTED_ROUNDS');
  if (reasons.length) {
    return {
      status: 'PROVISIONAL',
      strongerHidingTeam: null,
      marginSeconds: null,
      reasons,
      explanation: `Provisional: ${reasons.map((r) => REASON_TEXT[r]).join('; ')}.`,
    };
  }
  const ranked = [...scores].sort((x, y) => (y.hideSurvivalAverageSeconds ?? 0) - (x.hideSurvivalAverageSeconds ?? 0));
  const top = ranked[0]!.hideSurvivalAverageSeconds ?? 0;
  const second = ranked[1]!.hideSurvivalAverageSeconds ?? 0;
  if (top === second) {
    return { status: 'COMPARABLE', strongerHidingTeam: null, marginSeconds: 0, reasons: ['TIED'], explanation: 'Tied on average hiding time.' };
  }
  const stronger = ranked[0]!;
  return {
    status: 'COMPARABLE',
    strongerHidingTeam: stronger.team,
    marginSeconds: top - second,
    reasons: [],
    explanation: `${stronger.name} lasted longest on average while hiding.`,
  };
}

export function buildScorecard(session: Pick<SessionDoc, 'teams'>, results: RoundResult[]): Scorecard {
  const sorted = [...results].sort((x, y) => x.roundIndex - y.roundIndex);
  const keys = TEAM_KEYS.filter((k) => session.teams[k] || sorted.some((r) => r.hidingTeam === k || r.seekingTeams.includes(k)));
  const nameOf = (k: TeamKey) => session.teams[k]?.name ?? [...sorted].reverse().find((r) => r.teamNames[k])?.teamNames[k] ?? `Crew ${k}`;
  const teams: Partial<Record<TeamKey, TeamScore>> = Object.fromEntries(keys.map((k) => [k, teamScore(k, nameOf(k), sorted)]));
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
  /** round id → every operator phone in that round's snapshot */
  operatorUidsByRound: Record<string, string[]>;
}

export interface PersonAnalytics {
  personIds: string[];
  attribution: 'CREW_LEVEL';
  sessionsPlayed: number;
  roundsCrewHid: number;
  roundsCrewSought: number;
  crewHideSurvival: { rounds: number; averageSeconds: number | null; caught: number; censored: number; includesCensored: boolean };
  crewSeekCapture: { rounds: number; averageSeconds: number | null; uncaught: number; caughtByOtherCrew: number };
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
  const isMe = (p: PersonRef) => personIds.has(p.personId) || personIds.has(resolve(p.personId));
  const hideTimes: number[] = [];
  let censored = 0;
  let caught = 0;
  const seekTimes: number[] = [];
  let seekRounds = 0;
  let uncaught = 0;
  let caughtByOther = 0;
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
      const myKey = TEAM_KEYS.find((k) => (r.rosterSnapshot[k] ?? []).some(isMe));
      if (!myKey) continue;
      const onHiding = myKey === r.hidingTeam;
      if (!onHiding && !r.seekingTeams.includes(myKey)) continue;
      played = true;
      const roster = r.rosterSnapshot[myKey] ?? [];
      crewNames.add(r.teamNames[myKey] ?? `Crew ${myKey}`);
      myCrewKeys.add(myKey);
      for (const p of roster) {
        if (isMe(p)) continue;
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
        if (r.outcome === 'CAUGHT' && r.catchCreditTeams.includes(myKey)) seekTimes.push(r.observedChaseSeconds);
        else if (r.outcome === 'CAUGHT') caughtByOther++;
        else uncaught++;
      }
      compositions.set(fp, comp);
      if (linkedUid && operatorUidsByRound[r.roundId]?.includes(linkedUid)) operatorRounds++;
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
    crewSeekCapture: { rounds: seekRounds, averageSeconds: avg(seekTimes), uncaught, caughtByOtherCrew: caughtByOther },
    pairedNights: paired,
    compositions: [...compositions.entries()]
      .map(([fingerprint, c]) => ({ fingerprint, members: c.members, rounds: c.rounds, hideRounds: c.hideRounds, hideAverageSeconds: avg(c.hideTimes), censoredHideRounds: c.censored }))
      .sort((a, b) => b.rounds - a.rounds),
    coPlayers: [...coPlayers.entries()]
      .map(([personId, c]) => ({ personId, displayName: c.displayName, sessionsTogether: c.sessions.size }))
      .sort((a, b) => b.sessionsTogether - a.sessionsTogether),
    operatorRounds: linkedUid ? operatorRounds : null,
    sessions: sessions.sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate)),
    sampleNote: totalRounds < 8 ? `Small sample (${totalRounds} rounds). Crew-level, not individual.` : `Crew-level stats over ${totalRounds} rounds. Not individual performance.`,
  };
}
