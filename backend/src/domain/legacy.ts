import { TEAM_KEYS, type CrewRouteStats, type RoundBrief, type RoundDoc, type RoundResult, type TeamKey } from './types.js';

/**
 * Nights recorded before crews (one phone per crew, one seeking crew) are
 * upgraded to the current shape when they are read, so history, stats, export
 * and deletion keep working on them. Stored documents are not rewritten here.
 *
 * Each upgrade uses only the document's own fields. An old round's
 * `operatorsByTeam` comes from its frozen `hiderUid`/`seekerUid`, never from
 * current membership (snapshot authority, AGENTS §3.5). Current-shape and
 * partial documents (e.g. a `select()` projection) pass through unchanged.
 */

type Doc = Record<string, unknown>;

const isObject = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTeamKey = (v: unknown): v is TeamKey => typeof v === 'string' && (TEAM_KEYS as readonly string[]).includes(v);
const uidOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function upgradeSessionDoc(raw: Doc): Doc {
  let out = raw;
  if (isObject(raw.teams)) {
    const teams: Doc = { ...raw.teams };
    let changed = false;
    for (const k of TEAM_KEYS) {
      const t = teams[k];
      if (!isObject(t) || Array.isArray(t.operatorUids)) continue;
      const uid = uidOrNull(t.operatorUid);
      teams[k] = { ...t, operatorUids: uid ? [uid] : [] };
      changed = true;
    }
    if (changed) out = { ...out, teams };
  }
  if (Array.isArray(raw.roundBriefs) && raw.roundBriefs.some((b) => isObject(b) && !Array.isArray(b.seekingTeams))) {
    const present = isObject(raw.teams) ? TEAM_KEYS.filter((k) => isObject((raw.teams as Doc)[k])) : [...TEAM_KEYS];
    out = { ...out, roundBriefs: raw.roundBriefs.map((b) => (isObject(b) && !Array.isArray(b.seekingTeams) ? upgradeBrief(b, present) : b)) };
  }
  if ('teams' in raw && raw.joinCode === undefined) out = { ...out, joinCode: null };
  return out;
}

/** Before crews a night had exactly two crews, so the seeking crew is the other one. */
function upgradeBrief(b: Doc, present: TeamKey[]): RoundBrief {
  const hiding = b.hidingTeam as TeamKey;
  const seekingTeams = present.filter((k) => k !== hiding);
  return {
    ...(b as unknown as RoundBrief),
    seekingTeams,
    seekMode: 'TOGETHER',
    catchCreditTeams: b.outcome === 'CAUGHT' ? seekingTeams : [],
    // The roster at the time isn't on the session; views only display this field.
    hidingRosterFingerprint: typeof b.hidingRosterFingerprint === 'string' ? b.hidingRosterFingerprint : '',
  };
}

export function upgradeRoundDoc(raw: Doc): Doc {
  if (Array.isArray(raw.seekingTeams) || !isTeamKey(raw.hidingTeam) || !isTeamKey(raw.seekingTeam)) return raw;
  const h = raw.hidingTeam;
  const s = raw.seekingTeam;
  const hider = uidOrNull(raw.hiderUid);
  const seeker = uidOrNull(raw.seekerUid);
  const upgraded: Partial<RoundDoc> = {
    seekingTeams: [s],
    seekMode: 'TOGETHER',
    operatorsByTeam: { [h]: hider ? [hider] : [], [s]: seeker ? [seeker] : [] },
    routeSourceUids: { [h]: hider, [s]: seeker },
    waitingPing: (raw.waitingPing as RoundDoc['waitingPing'] | undefined) ?? null,
    // A pin's source phone wasn't recorded; null means "the round's lone hider phone".
    ...(Array.isArray(raw.pings) ? { pings: raw.pings.map((p) => (isObject(p) && p.sourceUid === undefined ? { ...p, sourceUid: null } : p)) as RoundDoc['pings'] } : {}),
    ...(isObject(raw.result) ? { result: upgradeRoundResult(raw.result, hider, seeker) } : {}),
  };
  return { ...raw, ...upgraded };
}

function upgradeRoundResult(r: Doc, hider: string | null, seeker: string | null): RoundResult {
  if (Array.isArray(r.seekingTeams)) return r as unknown as RoundResult;
  const h = r.hidingTeam as TeamKey;
  const s = r.seekingTeam as TeamKey;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const quality = (v: unknown) => (typeof v === 'string' ? v : 'INSUFFICIENT') as CrewRouteStats['routeQuality'];
  return {
    ...(r as unknown as RoundResult),
    seekingTeams: [s],
    seekMode: 'TOGETHER',
    teamNames: { [h]: r.hidingTeamName as string, [s]: r.seekingTeamName as string },
    rosterSnapshot: { [h]: (r.hidingRosterSnapshot as RoundResult['rosterSnapshot'][TeamKey]) ?? [], [s]: (r.seekingRosterSnapshot as RoundResult['rosterSnapshot'][TeamKey]) ?? [] },
    catchCreditTeams: r.outcome === 'CAUGHT' ? [s] : [],
    // One phone per crew, so each crew's route is that phone's.
    crews: {
      [h]: {
        role: 'HIDING',
        distanceTotalMeters: num(r.hidingDistanceTotalMeters),
        distanceChaseMeters: num(r.hidingDistanceChaseMeters),
        gpsCoverageFraction: num(r.gpsCoverageFractionHider),
        routeQuality: quality(r.routeQualityHider),
        phones: hider ? 1 : 0,
      },
      [s]: {
        role: 'SEEKING',
        distanceTotalMeters: null,
        distanceChaseMeters: num(r.seekingDistanceChaseMeters),
        gpsCoverageFraction: num(r.gpsCoverageFractionSeeker),
        routeQuality: quality(r.routeQualitySeeker),
        phones: seeker ? 1 : 0,
      },
    },
  };
}
