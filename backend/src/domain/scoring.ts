import { createHash } from 'node:crypto';
import { rosterFingerprint } from './crews.js';
import { TEAM_KEYS, type PersonRef, type RoundResult, type Rules, type SessionDoc, type TeamKey } from './types.js';

/**
 * Night scorecard and cross-night analytics (spec §6).
 *
 * - There is never a single-round winner. Catch credit (`catchCreditTeams`) is
 *   attribution only: RACE credits the claimant's crew, TOGETHER every seeking crew.
 * - Hide survival is computed only over rounds a crew hid; timed-out rounds are
 *   right-censored (observed >= cap) and flagged, never presented as a catch.
 * - A night comparison names a stronger hiding crew only when the comparison is
 *   balanced (every crew hid equally often, identical rules, the same people on
 *   every crew in every round, no censored/aborted rounds).
 * - Crews change during a night (ADR 0019): `matchups` compare crews only across
 *   rounds with the same people on each crew and the same rules; `changes` says
 *   what changed before each round.
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

/** One crew of a matchup: a set of people, whatever its colour in each round. */
export interface MatchupCrew {
  /** its colour (crew key) in the matchup's first round */
  team: TeamKey;
  name: string;
  people: PersonRef[];
  hideRounds: number;
  hideAverageSeconds: number | null;
  hideIncludesCensored: boolean;
  caught: number;
  uncaught: number;
  seekRounds: number;
  /** catches credited to this crew in rounds it sought */
  catches: number;
  /** crew-level, from each round's best-covered phone */
  hiderFootMeters: number;
  seekerVehicleMeters: number;
}

/** Rounds played by the same crews (the same people on each) under the same rules: the only fair comparison. */
export interface Matchup {
  /** round indexes, ascending */
  rounds: number[];
  rulesFingerprint: string;
  crews: MatchupCrew[];
  /** `strongerHidingTeam` is the stronger crew's colour in the matchup's first round */
  comparison: NightComparison;
}

/** Crew-attributed tallies for one person over the night (never individual performance). */
export interface PersonNightStats {
  personId: string;
  displayName: string;
  roundsHid: number;
  roundsSought: number;
  /** their crew's average hiding time over the rounds they hid */
  hideAverageSeconds: number | null;
  hideIncludesCensored: boolean;
  /** catches credited to their crew in rounds they sought */
  catches: number;
}

/** What changed since the previous played round. */
export interface RoundChanges {
  roundIndex: number;
  /** people on a crew this round who weren't in the previous round */
  joined: string[];
  /** people in the previous round who aren't on a crew this round (left or sitting out) */
  left: string[];
  /** people whose crew colour changed */
  moved: { name: string; from: TeamKey; to: TeamKey }[];
  rules: { field: keyof Rules | 'seekMode'; from: number | boolean | string | null; to: number | boolean | string | null }[];
}

export interface Scorecard {
  /** per crew colour across the night (older apps; misleading once crews change: see `matchups`) */
  teams: Partial<Record<TeamKey, TeamScore>>;
  comparison: NightComparison;
  rulesConsistent: boolean;
  rounds: RoundResult[];
  trend: { roundIndex: number; hidingTeam: TeamKey; observedChaseSeconds: number; isRightCensored: boolean; outcome: RoundResult['outcome'] }[];
  matchups: Matchup[];
  people: PersonNightStats[];
  /** one entry per round after the first */
  changes: RoundChanges[];
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

/** True when any crew had different people in any two rounds — hiding or seeking (ADR 0019). */
function rostersChanged(valid: RoundResult[]): boolean {
  const byCrew = new Map<TeamKey, Set<string>>();
  for (const r of valid) {
    for (const k of [r.hidingTeam, ...r.seekingTeams]) {
      const set = byCrew.get(k) ?? new Set<string>();
      set.add(rosterFingerprint(r.rosterSnapshot[k]));
      byCrew.set(k, set);
    }
  }
  return [...byCrew.values()].some((s) => s.size > 1);
}

const REASON_TEXT: Record<string, string> = {
  UNEQUAL_HIDE_ROUNDS: 'crews hid an unequal number of times',
  RULES_DIFFER: 'rules changed between rounds',
  ROSTERS_CHANGED: 'crews changed between rounds',
  CENSORED_ROUNDS: 'a round timed out',
  ABORTED_ROUNDS: 'a round was aborted',
};

export function compareNight(teams: Partial<Record<TeamKey, TeamScore>>, results: RoundResult[]): NightComparison {
  const valid = results.filter((r) => r.outcome !== 'ABORTED');
  const scores = playingCrews(results)
    .map((k) => teams[k])
    .filter((t): t is TeamScore => !!t)
    .map((t) => ({ team: t.team, name: t.name, hides: t.hideRoundCount, average: t.hideSurvivalAverageSeconds }));
  const reasons: string[] = [];
  if (new Set(valid.map((r) => r.rulesFingerprint)).size > 1) reasons.push('RULES_DIFFER');
  if (rostersChanged(valid)) reasons.push('ROSTERS_CHANGED');
  return compareCrews(scores, results, reasons);
}

/**
 * The comparison core, for a night or a matchup: a stronger hiding crew only when every crew hid
 * equally often and nothing else (`extra` reasons, censored or aborted rounds) makes it unfair.
 */
function compareCrews(scores: { team: TeamKey; name: string; hides: number; average: number | null }[], results: RoundResult[], extra: string[]): NightComparison {
  const valid = results.filter((r) => r.outcome !== 'ABORTED');
  if (scores.length < 2 || scores.some((t) => t.hides === 0)) {
    return {
      status: 'INSUFFICIENT',
      strongerHidingTeam: null,
      marginSeconds: null,
      reasons: ['EVERY_CREW_MUST_HIDE'],
      explanation: 'Every crew needs a hiding round before crews can be compared.',
    };
  }
  const reasons: string[] = [];
  if (new Set(scores.map((t) => t.hides)).size > 1) reasons.push('UNEQUAL_HIDE_ROUNDS');
  reasons.push(...extra);
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
  const ranked = [...scores].sort((x, y) => (y.average ?? 0) - (x.average ?? 0));
  const top = ranked[0]!.average ?? 0;
  const second = ranked[1]!.average ?? 0;
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

/** The people on each crew of a round, as a key-independent set of crews (sorted person ids per crew). */
const crewSets = (r: RoundResult) => [r.hidingTeam, ...r.seekingTeams].map((k) => ({ k, fp: rosterFingerprint(r.rosterSnapshot[k]) || `~${k}` }));

export function buildMatchups(results: RoundResult[]): Matchup[] {
  const groups = new Map<string, RoundResult[]>();
  for (const r of results) {
    const key = `${crewSets(r).map((c) => c.fp).sort().join('|')}#${r.rulesFingerprint}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rounds) => {
    const first = rounds[0]!;
    const crews = crewSets(first).sort((a, b) => a.k.localeCompare(b.k)).map(({ k, fp }) => {
      const keyIn = (r: RoundResult) => crewSets(r).find((c) => c.fp === fp)!.k;
      const valid = rounds.filter((r) => r.outcome !== 'ABORTED');
      const hid = valid.filter((r) => r.hidingTeam === keyIn(r));
      const sought = valid.filter((r) => r.hidingTeam !== keyIn(r));
      return {
        team: k,
        name: first.teamNames[k] ?? `Crew ${k}`,
        people: first.rosterSnapshot[k] ?? [],
        hideRounds: hid.length,
        hideAverageSeconds: avg(hid.map((r) => r.observedChaseSeconds)),
        hideIncludesCensored: hid.some((r) => r.isRightCensored),
        caught: hid.filter((r) => r.outcome === 'CAUGHT').length,
        uncaught: hid.filter((r) => r.outcome === 'TIMED_OUT').length,
        seekRounds: sought.length,
        catches: sought.filter((r) => r.outcome === 'CAUGHT' && r.catchCreditTeams.includes(keyIn(r))).length,
        hiderFootMeters: sum(hid.map((r) => r.crews[keyIn(r)]?.distanceTotalMeters)),
        seekerVehicleMeters: sum(sought.map((r) => r.crews[keyIn(r)]?.distanceChaseMeters)),
      } satisfies MatchupCrew;
    });
    const comparison = compareCrews(crews.map((c) => ({ team: c.team, name: c.name, hides: c.hideRounds, average: c.hideAverageSeconds })), rounds, []);
    return { rounds: rounds.map((r) => r.roundIndex), rulesFingerprint: first.rulesFingerprint, crews, comparison };
  });
}

export function personNightStats(results: RoundResult[]): PersonNightStats[] {
  const out = new Map<string, PersonNightStats & { hideTimes: number[] }>();
  for (const r of results.filter((x) => x.outcome !== 'ABORTED')) {
    for (const k of [r.hidingTeam, ...r.seekingTeams]) {
      for (const p of r.rosterSnapshot[k] ?? []) {
        const st = out.get(p.personId) ?? { personId: p.personId, displayName: p.displayName, roundsHid: 0, roundsSought: 0, hideAverageSeconds: null, hideIncludesCensored: false, catches: 0, hideTimes: [] };
        st.displayName = p.displayName;
        if (k === r.hidingTeam) {
          st.roundsHid++;
          st.hideTimes.push(r.observedChaseSeconds);
          st.hideIncludesCensored ||= r.isRightCensored;
        } else {
          st.roundsSought++;
          if (r.outcome === 'CAUGHT' && r.catchCreditTeams.includes(k)) st.catches++;
        }
        out.set(p.personId, st);
      }
    }
  }
  return [...out.values()].map(({ hideTimes, ...st }) => ({ ...st, hideAverageSeconds: avg(hideTimes) }));
}

/** Before each round after the first: who joined, left or moved crews, and which rules changed. */
export function roundChanges(results: RoundResult[], rulesByRound: Record<string, Rules> = {}): RoundChanges[] {
  const placeOf = (r: RoundResult) => {
    const m = new Map<string, { key: TeamKey; name: string }>();
    for (const k of [r.hidingTeam, ...r.seekingTeams]) for (const p of r.rosterSnapshot[k] ?? []) m.set(p.personId, { key: k, name: p.displayName });
    return m;
  };
  const out: RoundChanges[] = [];
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1]!;
    const cur = results[i]!;
    const [a, b] = [placeOf(prev), placeOf(cur)];
    const rules: RoundChanges['rules'] = [];
    const ra = rulesByRound[prev.roundId];
    const rb = rulesByRound[cur.roundId];
    if (ra && rb) for (const f of Object.keys(rb) as (keyof Rules)[]) if (ra[f] !== rb[f]) rules.push({ field: f, from: ra[f] ?? null, to: rb[f] ?? null });
    if (prev.seekingTeams.length > 1 && cur.seekingTeams.length > 1 && prev.seekMode !== cur.seekMode) rules.push({ field: 'seekMode', from: prev.seekMode, to: cur.seekMode });
    out.push({
      roundIndex: cur.roundIndex,
      joined: [...b].filter(([id]) => !a.has(id)).map(([, p]) => p.name),
      left: [...a].filter(([id]) => !b.has(id)).map(([, p]) => p.name),
      moved: [...b].filter(([id, p]) => a.has(id) && a.get(id)!.key !== p.key).map(([id, p]) => ({ name: p.name, from: a.get(id)!.key, to: p.key })),
      rules,
    });
  }
  return out;
}

export function buildScorecard(session: Pick<SessionDoc, 'teams'>, results: RoundResult[], rulesByRound: Record<string, Rules> = {}): Scorecard {
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
    matchups: buildMatchups(sorted),
    people: personNightStats(sorted),
    changes: roundChanges(sorted, rulesByRound),
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
