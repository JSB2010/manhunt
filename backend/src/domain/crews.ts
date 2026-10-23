import { TEAM_KEYS, type MemberDoc, type PersonRef, type Role, type RoundDoc, type SessionDoc, type Side, type TeamKey } from './types.js';

/**
 * Crew membership and round roles.
 *
 * Two sources of truth, deliberately separate:
 *  - the night's people: `session.teams[k].roster` and `session.bench` (edited
 *    between rounds and on join). Phones follow their owners: `operatorUids` is
 *    derived from the rosters by `placePhones` (ADR 0019);
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

/** Where a person is in the night: a crew, sitting out (`BENCH`), or not in the night (ADR 0019). */
export type Place = TeamKey | 'BENCH';

export const benchOf = (session: Pick<SessionDoc, 'bench'>): PersonRef[] => session.bench ?? [];

export function placeOfPerson(session: SessionDoc, personId: string): Place | null {
  return crewOfPerson(session, personId) ?? (benchOf(session).some((p) => p.personId === personId) ? 'BENCH' : null);
}

/** Everyone in the night: the crews in key order, then the people sitting out. */
export function peopleOf(session: SessionDoc): PersonRef[] {
  return [...teamKeysOf(session).flatMap((k) => session.teams[k]!.roster), ...benchOf(session)];
}

/** The crew a phone is on, or `BENCH` for a phone in the night whose owner sits out. */
export function placeOfPhone(session: SessionDoc, member: Pick<MemberDoc, 'uid' | 'active'> | undefined): Place | null {
  if (!member?.active) return null;
  return crewOfUid(session, member.uid) ?? 'BENCH';
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
  const entries = peopleOf(session);
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
  if (member.rosterPersonId && placeOfPerson(session, member.rosterPersonId)) return member.rosterPersonId;
  if (member.selfPersonId && placeOfPerson(session, member.selfPersonId)) return member.selfPersonId;
  const named = peopleOf(session).filter((p) => nameKey(p.displayName) === nameKey(member.displayName));
  return named.length === 1 ? named[0]!.personId : null;
}

/** Move a person to crew `to` or the bench (in place). Returns where they left, or null if they didn't move. */
export function movePerson(session: SessionDoc, personId: string, to: Place): Place | null {
  const from = placeOfPerson(session, personId);
  if (!from || from === to || (to !== 'BENCH' && !session.teams[to])) return null;
  const list = (p: Place) => (p === 'BENCH' ? benchOf(session) : session.teams[p]!.roster);
  const entry = list(from).find((p) => p.personId === personId)!;
  const rest = list(from).filter((p) => p.personId !== personId);
  if (from === 'BENCH') session.bench = rest;
  else session.teams[from]!.roster = rest;
  if (to === 'BENCH') session.bench = [...benchOf(session), entry];
  else session.teams[to]!.roster.push(entry);
  return from;
}

/** Move a person's roster entry to crew `to` (in place). Returns where they left, or null if they didn't move. */
export const movePersonToCrew = (session: SessionDoc, personId: string, to: TeamKey): Place | null => movePerson(session, personId, to);

// ---------------------------------------------------------------------------
// Phones follow their owners (ADR 0019)
// ---------------------------------------------------------------------------

/** A phone that changed place: `to` null means it left the night with its owner. */
export interface PhonePlacement {
  uid: string;
  from: Place | null;
  to: Place | null;
}

/**
 * Put every active phone where its owner is: on the owner's crew, or on the bench when they sit
 * out (in place; also updates each member's link and `teamKey`). A linked phone whose owner is no
 * longer in the night leaves it. A phone from before the link with no owner found stays where it
 * was and its account's own person is listed there, so it has one from now on.
 */
export function placePhones(session: SessionDoc, members: Record<string, MemberDoc>): PhonePlacement[] {
  const before = new Map<string, Place>();
  for (const k of teamKeysOf(session)) for (const u of session.teams[k]!.operatorUids) before.set(u, k);
  const order = [...new Set([...teamKeysOf(session).flatMap((k) => session.teams[k]!.operatorUids), ...Object.keys(members).sort()])];
  const placed = new Map<string, Place>();
  const changes: PhonePlacement[] = [];
  for (const uid of order) {
    const m = members[uid];
    const from = m?.active ? (before.get(uid) ?? 'BENCH') : (before.get(uid) ?? null);
    let owner = m?.active ? ownerPersonId(session, m) : null;
    let to: Place | null = owner ? placeOfPerson(session, owner) : null;
    if (m?.active && !owner && !m.rosterPersonId) {
      // No owner and never linked (a phone from before ADR 0018): keep it where it was.
      to = before.get(uid) ?? 'BENCH';
      if (m.selfPersonId) {
        const entry = { personId: m.selfPersonId, displayName: m.displayName };
        if (to === 'BENCH') session.bench = [...benchOf(session), entry];
        else session.teams[to]!.roster.push(entry);
        if (!session.participantPersonIds.includes(m.selfPersonId)) session.participantPersonIds.push(m.selfPersonId);
        owner = m.selfPersonId;
      }
    }
    if (m && to) {
      members[uid] = { ...m, rosterPersonId: owner ?? m.rosterPersonId ?? null, ...(to !== 'BENCH' ? { teamKey: to } : {}) };
      placed.set(uid, to);
    }
    if (from !== to) changes.push({ uid, from, to });
  }
  // Phones that stayed keep their order; phones that arrived go after them.
  for (const k of teamKeysOf(session)) {
    const stayed = session.teams[k]!.operatorUids.filter((u) => placed.get(u) === k);
    session.teams[k]!.operatorUids = [...stayed, ...order.filter((u) => placed.get(u) === k && !stayed.includes(u))];
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Crew names: the crew's people (ADR 0019)
// ---------------------------------------------------------------------------

const COLOUR_NAMES: Record<TeamKey, string> = { A: 'Blue', B: 'Orange', C: 'Green' };

/** A crew's colour as words ("Blue crew"): the name of an empty crew, and the Lock Screen label (never people's names). */
export const crewColourName = (k: TeamKey) => `${COLOUR_NAMES[k]} crew`;

/**
 * Short names for everyone in the night: first names; a last initial where two people share a
 * first name ("Marco B.", "Marco R."), or the full name when that is shared too.
 */
export function shortNames(people: readonly PersonRef[]): Map<string, string> {
  const parts = (p: PersonRef) => p.displayName.trim().split(/\s+/);
  const groups = new Map<string, PersonRef[]>();
  for (const p of people) {
    const first = parts(p)[0]!.toLowerCase();
    groups.set(first, [...(groups.get(first) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    const initials = (p: PersonRef) => {
      const w = parts(p);
      return w.length > 1 ? `${w[0]} ${w.at(-1)![0]!.toUpperCase()}.` : w[0]!;
    };
    const distinct = group.length === 1 || new Set(group.map((p) => initials(p).toLowerCase())).size === group.length;
    for (const p of group) out.set(p.personId, group.length === 1 ? parts(p)[0]! : distinct ? initials(p) : p.displayName.trim());
  }
  return out;
}

/** "Sasha", "Sasha & Marco", "Sasha, Marco & Theo", "Sasha, Marco & 3 more"; an empty crew is its colour. */
export function crewLabel(roster: readonly PersonRef[], key: TeamKey, short: ReadonlyMap<string, string> = shortNames(roster)): string {
  const names = roster.map((p) => short.get(p.personId) ?? p.displayName.trim());
  if (!names.length) return crewColourName(key);
  if (names.length === 1) return names[0]!;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
  return `${names.slice(0, 2).join(', ')} & ${names.length - 2} more`;
}

/** Name every crew after its people (in place). Called after every change to the night's people. */
export function relabelCrews(session: SessionDoc): void {
  const short = shortNames(peopleOf(session));
  for (const k of teamKeysOf(session)) session.teams[k]!.name = crewLabel(session.teams[k]!.roster, k, short);
}

/** More than one person: "Sasha & Marco hide", but "Sasha hides" and "Blue crew hides". */
export const isPlural = (roster: readonly unknown[] | undefined) => (roster?.length ?? 0) > 1;
