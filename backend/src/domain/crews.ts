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
