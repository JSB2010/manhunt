import { TEAM_KEYS, type Role, type RoundDoc, type SessionDoc, type Side, type TeamKey } from './types.js';

/**
 * Crew membership and round roles.
 *
 * Two sources of truth, deliberately separate:
 *  - `session.teams[k].operatorUids` is the night's current crew list (edited
 *    between rounds, on join, on move);
 *  - `round.operatorsByTeam` is frozen when a round starts. Every in-round
 *    permission and every post-round artifact uses the round snapshot, so a
 *    phone that joins or moves mid-round cannot act in, or read, that round.
 */

/** Crews present in the night, in key order. */
export function teamKeysOf(session: SessionDoc): TeamKey[] {
  return TEAM_KEYS.filter((k) => !!session.teams[k]);
}

/** The crew a phone currently belongs to in the night (null if not an operator). */
export function crewOfUid(session: SessionDoc, uid: string): TeamKey | null {
  for (const k of teamKeysOf(session)) if (session.teams[k]!.operatorUids.includes(uid)) return k;
  return null;
}

export function operatorUidsOf(session: SessionDoc): string[] {
  return teamKeysOf(session).flatMap((k) => session.teams[k]!.operatorUids);
}

/** Crews taking part in a round: the hiders first, then the seekers. */
export function roundTeams(r: Pick<RoundDoc, 'hidingTeam' | 'seekingTeams'>): TeamKey[] {
  return [r.hidingTeam, ...r.seekingTeams];
}

/** The crew a phone played for in this round (snapshot), or null for spectators. */
export function snapshotTeamOf(r: Pick<RoundDoc, 'operatorsByTeam'>, uid: string): TeamKey | null {
  for (const k of TEAM_KEYS) if (r.operatorsByTeam[k]?.includes(uid)) return k;
  return null;
}

export function roleOfTeam(r: Pick<RoundDoc, 'hidingTeam' | 'seekingTeams'>, team: TeamKey | null): Role | null {
  if (team === null) return null;
  if (team === r.hidingTeam) return 'HIDING';
  return r.seekingTeams.includes(team) ? 'SEEKING' : null;
}

/** Role of a phone in a started round (snapshot only). */
export function roleOf(r: Pick<RoundDoc, 'hidingTeam' | 'seekingTeams' | 'operatorsByTeam'>, uid: string): Role | null {
  return roleOfTeam(r, snapshotTeamOf(r, uid));
}

export function sideOfRole(role: Role): Side {
  return role === 'HIDING' ? 'HIDERS' : 'SEEKERS';
}

export const hiderUids = (r: Pick<RoundDoc, 'hidingTeam' | 'operatorsByTeam'>): string[] => r.operatorsByTeam[r.hidingTeam] ?? [];

export const seekerUids = (r: Pick<RoundDoc, 'seekingTeams' | 'operatorsByTeam'>): string[] =>
  r.seekingTeams.flatMap((k) => r.operatorsByTeam[k] ?? []);

/** Every phone in the round's snapshot. */
export const roundUids = (r: Pick<RoundDoc, 'hidingTeam' | 'seekingTeams' | 'operatorsByTeam'>): string[] => [
  ...hiderUids(r),
  ...seekerUids(r),
];

/** Stable fingerprint of a roster (sorted person ids). */
export function rosterFingerprint(roster: readonly { personId: string }[] | undefined): string {
  return [...(roster ?? [])].map((p) => p.personId).sort().join(',');
}

// ---------------------------------------------------------------------------
// A phone's owner on the rosters (ADR 0018)
// ---------------------------------------------------------------------------

/** The crew whose roster lists a person, or null. */
export function crewOfPerson(session: SessionDoc, personId: string): TeamKey | null {
  for (const k of teamKeysOf(session)) if (session.teams[k]!.roster.some((p) => p.personId === personId)) return k;
  return null;
}

const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const compactKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const words = (s: string) => nameKey(s).split(' ').filter((w) => w.length >= 2);

/**
 * The roster entry a joining phone's owner most likely already is: their own person record,
 * then the same name, the same letters ("rileyquinn" = "Riley Quinn"), and finally a
 * one-word name that is a word of exactly one longer name ("Sasha" = "Sasha Okafor", or the
 * reverse). Entries already linked to another phone are skipped; an ambiguous match is no match.
 */
export function matchRosterPerson(
  session: SessionDoc,
  owner: { displayName: string; selfPersonId: string | null },
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  const entries = teamKeysOf(session).flatMap((k) => session.teams[k]!.roster);
  if (owner.selfPersonId && entries.some((p) => p.personId === owner.selfPersonId)) return owner.selfPersonId;
  const free = entries.filter((p) => !claimed.has(p.personId) && p.personId !== owner.selfPersonId);
  const unique = (pred: (p: { displayName: string }) => boolean) => {
    const hits = free.filter(pred);
    return hits.length === 1 ? hits[0]!.personId : null;
  };
  const name = owner.displayName;
  if (!nameKey(name)) return null;
  const oneWord = (a: string, b: string) => {
    const [wa, wb] = [words(a), words(b)];
    return (wa.length === 1 && wb.length > 1 && wb.includes(wa[0]!)) || (wb.length === 1 && wa.length > 1 && wa.includes(wb[0]!));
  };
  return (
    unique((p) => nameKey(p.displayName) === nameKey(name)) ??
    (compactKey(name).length >= 3 ? unique((p) => compactKey(p.displayName) === compactKey(name)) : null) ??
    unique((p) => oneWord(name, p.displayName))
  );
}

/**
 * The roster person a phone's owner plays as: the link made when the phone joined, else
 * their own person record or (nights from before the link) a roster name equal to theirs.
 */
export function ownerPersonId(session: SessionDoc, member: { rosterPersonId?: string | null; selfPersonId: string | null; displayName: string }): string | null {
  if (member.rosterPersonId && crewOfPerson(session, member.rosterPersonId)) return member.rosterPersonId;
  if (member.selfPersonId && crewOfPerson(session, member.selfPersonId)) return member.selfPersonId;
  const named = teamKeysOf(session).flatMap((k) => session.teams[k]!.roster).filter((p) => nameKey(p.displayName) === nameKey(member.displayName));
  return named.length === 1 ? named[0]!.personId : null;
}

/** Move a person's roster entry to crew `to` (in place). Returns the crew it left, or null if it didn't move. */
export function movePersonToCrew(session: SessionDoc, personId: string, to: TeamKey): TeamKey | null {
  const from = crewOfPerson(session, personId);
  if (!from || from === to || !session.teams[to]) return null;
  const entry = session.teams[from]!.roster.find((p) => p.personId === personId)!;
  session.teams[from]!.roster = session.teams[from]!.roster.filter((p) => p.personId !== personId);
  session.teams[to]!.roster.push(entry);
  return from;
}
