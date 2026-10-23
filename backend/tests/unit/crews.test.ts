import { describe, expect, it } from 'vitest';
import {
  crewLabel,
  crewOfPerson,
  crewOfUid,
  matchRosterPerson,
  movePerson,
  movePersonToCrew,
  ownerPersonId,
  placeOfPerson,
  placeOfPhone,
  placePhones,
  relabelCrews,
  shortNames,
} from '../../src/domain/crews.js';
import { startRound, trackingNudges, TRACKING_NUDGE_AFTER_MS, TRACKING_NUDGE_EVERY_MS, TRACKING_SILENT_MS } from '../../src/domain/engine.js';
import type { PersonRef, SessionDoc } from '../../src/domain/types.js';
import { allPhones, health, HIDER, HIDER2, members, MIN, readyRound, SEEKER, session, T0 } from './fixtures.js';

/** The rosters typed by the organizer on 2026-10-22 (names only; the accounts that joined used shorter names). */
function typedNight(): SessionDoc {
  const s = session();
  s.teams.A!.roster = [
    { personId: 'p-jordan', displayName: 'Jordan Avery' },
    { personId: 'p-sasha', displayName: 'Sasha Okafor' },
    { personId: 'p-dana', displayName: 'Dana Whitfield' },
    { personId: 'p-theo', displayName: 'Theo Marsh' },
  ];
  s.teams.B!.roster = [
    { personId: 'p-marco', displayName: 'Marco Bellini' },
    { personId: 'p-riley', displayName: 'Riley Quinn' },
    { personId: 'p-priya', displayName: 'Priya Nandan' },
  ];
  return s;
}

describe('a joining phone is matched to the name typed for its owner (ADR 0018)', () => {
  it('matches the same name, the same letters, or a one-word name inside one full name', () => {
    const s = typedNight();
    expect(matchRosterPerson(s, { displayName: 'Priya Nandan', selfPersonId: 'self-priya' })).toBe('p-priya');
    expect(matchRosterPerson(s, { displayName: '  priya   nandan ', selfPersonId: null })).toBe('p-priya');
    expect(matchRosterPerson(s, { displayName: 'rileyquinn', selfPersonId: 'self-riley' })).toBe('p-riley');
    expect(matchRosterPerson(s, { displayName: 'Sasha', selfPersonId: 'self-sasha' })).toBe('p-sasha');
    expect(matchRosterPerson(s, { displayName: 'Theo', selfPersonId: 'self-theo' })).toBe('p-theo');
    expect(matchRosterPerson(s, { displayName: 'whitfield', selfPersonId: 'self-whitfield' })).toBe('p-dana');
    // The reverse: the organizer typed a first name, the account has the full name.
    s.teams.B!.roster.push({ personId: 'p-ezra', displayName: 'Ezra' });
    expect(matchRosterPerson(s, { displayName: 'Ezra Holt', selfPersonId: null })).toBe('p-ezra');
  });

  it('prefers the account’s own person record when a crew already lists it', () => {
    const s = typedNight();
    s.teams.B!.roster.push({ personId: 'self-marco', displayName: 'Marco' });
    expect(matchRosterPerson(s, { displayName: 'Marco', selfPersonId: 'self-marco' })).toBe('self-marco');
  });

  it('never guesses between two candidates, and skips names another phone already plays as', () => {
    const s = typedNight();
    s.teams.A!.roster.push({ personId: 'p-marco2', displayName: 'Marco Ruiz' });
    expect(matchRosterPerson(s, { displayName: 'Marco', selfPersonId: null })).toBeNull();
    expect(matchRosterPerson(s, { displayName: 'Marco', selfPersonId: null }, new Set(['p-marco2']))).toBe('p-marco');
    expect(matchRosterPerson(s, { displayName: 'Sasha', selfPersonId: null }, new Set(['p-sasha']))).toBeNull();
    expect(matchRosterPerson(s, { displayName: 'Sam', selfPersonId: null })).toBeNull();
    expect(matchRosterPerson(s, { displayName: '  ', selfPersonId: null })).toBeNull();
  });
});

describe('a phone’s owner on the rosters', () => {
  it('is the linked roster person, else their own record, else a unique equal name', () => {
    const s = typedNight();
    expect(ownerPersonId(s, { rosterPersonId: 'p-sasha', selfPersonId: 'self-sasha', displayName: 'Sasha' })).toBe('p-sasha');
    // A link to a name no longer on any crew falls back.
    s.teams.B!.roster.push({ personId: 'self-marco', displayName: 'Marco' });
    expect(ownerPersonId(s, { rosterPersonId: 'p-gone', selfPersonId: 'self-marco', displayName: 'Marco' })).toBe('self-marco');
    // Nights from before the link: the typed name equal to the account's.
    expect(ownerPersonId(s, { selfPersonId: 'self-priya', displayName: 'Priya Nandan' })).toBe('p-priya');
    expect(ownerPersonId(s, { selfPersonId: null, displayName: 'Nobody' })).toBeNull();
  });

  it('moves with its phone: the name leaves its old crew for the new one', () => {
    const s = typedNight();
    expect(movePersonToCrew(s, 'p-marco', 'A')).toBe('B');
    expect(crewOfPerson(s, 'p-marco')).toBe('A');
    expect(s.teams.B!.roster.map((p) => p.personId)).not.toContain('p-marco');
    expect(s.teams.A!.roster.at(-1)).toEqual({ personId: 'p-marco', displayName: 'Marco Bellini' });
    expect(movePersonToCrew(s, 'p-marco', 'A')).toBeNull(); // already there
    expect(movePersonToCrew(s, 'p-unknown', 'B')).toBeNull();
  });
});

const ref = (personId: string, displayName: string): PersonRef => ({ personId, displayName });

describe('crews are named after their people (ADR 0019)', () => {
  it('lists first names, then "& N more"; an empty crew is its colour', () => {
    const people = [ref('a', 'Sasha Okafor'), ref('b', 'Marco Bellini'), ref('c', 'Theo Marsh'), ref('d', 'Dana Whitfield'), ref('e', 'Priya Nandan')];
    expect(crewLabel(people.slice(0, 1), 'A')).toBe('Sasha');
    expect(crewLabel(people.slice(0, 2), 'A')).toBe('Sasha & Marco');
    expect(crewLabel(people.slice(0, 3), 'A')).toBe('Sasha, Marco & Theo');
    expect(crewLabel(people.slice(0, 4), 'A')).toBe('Sasha, Marco & 2 more');
    expect(crewLabel(people, 'B')).toBe('Sasha, Marco & 3 more');
    expect(crewLabel([], 'A')).toBe('Blue crew');
    expect(crewLabel([], 'B')).toBe('Orange crew');
    expect(crewLabel([], 'C')).toBe('Green crew');
    expect(crewLabel([ref('x', 'rileyquinn')], 'C')).toBe('rileyquinn');
  });

  it('tells apart two people with the same first name, across the whole night', () => {
    const short = shortNames([ref('a', 'Marco Bellini'), ref('b', 'Marco Ruiz'), ref('c', 'Sam'), ref('d', 'Sam'), ref('e', 'Ezra Holt'), ref('f', 'Ezra Hart')]);
    expect(short.get('a')).toBe('Marco B.');
    expect(short.get('b')).toBe('Marco R.');
    expect(short.get('c')).toBe('Sam'); // nothing more to go on
    expect(short.get('e')).toBe('Ezra Holt'); // same initial: the full name
    const s = typedNight();
    s.teams.A!.roster.push(ref('p-marco2', 'Marco Ruiz'));
    relabelCrews(s);
    expect(s.teams.A!.name).toBe('Jordan, Sasha & 3 more');
    s.teams.B!.roster = [ref('p-marco', 'Marco Bellini')];
    relabelCrews(s);
    expect(s.teams.B!.name).toBe('Marco B.');
  });
});

describe('phones follow their owners (ADR 0019)', () => {
  /** Night with crews A (Morgan's and Casey's phones) and B (Taylor's), every phone linked to its owner. */
  function linkedNight() {
    const s = session({}, { phonesA: [HIDER, HIDER2] });
    const m = members(s);
    m[HIDER] = { ...m[HIDER]!, rosterPersonId: 'p-morgan' };
    m[HIDER2] = { ...m[HIDER2]!, rosterPersonId: 'p-casey' };
    m[SEEKER] = { ...m[SEEKER]!, rosterPersonId: 'p-taylor' };
    return { s, m };
  }

  it('moving a person moves their phone; nothing else moves', () => {
    const { s, m } = linkedNight();
    movePerson(s, 'p-casey', 'B');
    expect(placePhones(s, m)).toEqual([{ uid: HIDER2, from: 'A', to: 'B' }]);
    expect(s.teams.A!.operatorUids).toEqual([HIDER]);
    expect(s.teams.B!.operatorUids).toEqual([SEEKER, HIDER2]);
    expect(m[HIDER2]!.teamKey).toBe('B');
    expect(placePhones(s, m)).toEqual([]); // settled
  });

  it('a person sitting out keeps their phone in the night, off every crew', () => {
    const { s, m } = linkedNight();
    expect(movePerson(s, 'p-casey', 'BENCH')).toBe('A');
    expect(placeOfPerson(s, 'p-casey')).toBe('BENCH');
    expect(placePhones(s, m)).toEqual([{ uid: HIDER2, from: 'A', to: 'BENCH' }]);
    expect(crewOfUid(s, HIDER2)).toBeNull();
    expect(m[HIDER2]!.active).toBe(true);
    expect(placeOfPhone(s, m[HIDER2])).toBe('BENCH');
    // Back from the bench, the phone goes with them.
    movePerson(s, 'p-casey', 'B');
    expect(placePhones(s, m)).toEqual([{ uid: HIDER2, from: 'BENCH', to: 'B' }]);
  });

  it('a person removed from the night takes their phone out; a name without a phone just leaves', () => {
    const { s, m } = linkedNight();
    s.teams.A!.roster = s.teams.A!.roster.filter((p) => p.personId !== 'p-casey' && p.personId !== 'p-jules');
    expect(placePhones(s, m)).toEqual([{ uid: HIDER2, from: 'A', to: null }]);
    expect(s.teams.A!.operatorUids).toEqual([HIDER]);
  });

  it('a phone taken out of the night (inactive) leaves its crew; its owner stays listed', () => {
    const { s, m } = linkedNight();
    m[HIDER2] = { ...m[HIDER2]!, active: false };
    expect(placePhones(s, m)).toEqual([{ uid: HIDER2, from: 'A', to: null }]);
    expect(crewOfPerson(s, 'p-casey')).toBe('A');
  });

  it('a phone from before the link keeps its crew, and its account is listed there from now on', () => {
    const s = session();
    const m = members(s);
    m[SEEKER] = { ...m[SEEKER]!, displayName: 'taylor m', selfPersonId: 'self-taylor', rosterPersonId: undefined };
    m[HIDER] = { ...m[HIDER]!, displayName: 'Morgan', selfPersonId: null }; // matched by name
    expect(placePhones(s, m)).toEqual([]);
    expect(s.teams.B!.roster.at(-1)).toEqual(ref('self-taylor', 'taylor m'));
    expect(m[SEEKER]!.rosterPersonId).toBe('self-taylor');
    expect(m[HIDER]!.rosterPersonId).toBe('p-morgan');
    expect(s.participantPersonIds).toContain('self-taylor');
  });

  it('a joining phone can be matched to a name sitting out', () => {
    const s = typedNight();
    s.bench = [ref('p-ezra', 'Ezra Holt')];
    expect(matchRosterPerson(s, { displayName: 'Ezra', selfPersonId: null })).toBe('p-ezra');
    expect(ownerPersonId(s, { rosterPersonId: 'p-ezra', selfPersonId: null, displayName: 'x' })).toBe('p-ezra');
  });
});

describe('tracking nudges', () => {
  const started = () => {
    const { session: s, round } = readyRound();
    return { s, round: startRound(round, s, HIDER, allPhones(s), [], T0).round };
  };

  it('nudges a phone that hasn’t reported since the start, once, after a minute', () => {
    const { s, round } = started();
    const m = members(s);
    m[HIDER]!.health = health({ lastHeartbeatAt: T0 + 5_000 });
    m[SEEKER]!.health = health({ lastHeartbeatAt: T0 - 2 * MIN }); // its Ready check, before the start
    expect(trackingNudges(round, m, T0 + TRACKING_NUDGE_AFTER_MS - 1)).toEqual([]);
    const [n, ...rest] = trackingNudges(round, m, T0 + TRACKING_NUDGE_AFTER_MS);
    expect(rest).toEqual([]);
    expect(n).toMatchObject({ toUids: [SEEKER], kind: 'TRACKING_NUDGE', title: 'Your phone isn’t tracking' });
    expect(n!.body).toContain('Round 1');
    expect(JSON.stringify(n)).not.toMatch(/\d+\.\d{3,}/); // no coordinates
    m[SEEKER]!.trackingNudge = { roundId: round.id, at: T0 + TRACKING_NUDGE_AFTER_MS };
    expect(trackingNudges(round, m, T0 + 5 * MIN)).toEqual([]);
    m[HIDER]!.health = health({ lastHeartbeatAt: T0 + 10 * MIN });
    expect(trackingNudges(round, m, T0 + TRACKING_NUDGE_AFTER_MS + TRACKING_NUDGE_EVERY_MS).map((x) => x.toUids)).toEqual([[SEEKER]]);
  });

  it('nudges a hider phone that goes quiet mid-round, with the hider wording; never while paused or after the round', () => {
    const { s, round } = started();
    const m = members(s);
    m[SEEKER]!.health = health({ lastHeartbeatAt: T0 + 6 * MIN });
    m[HIDER]!.health = health({ lastHeartbeatAt: T0 + 1 * MIN });
    const [n] = trackingNudges(round, m, T0 + 1 * MIN + TRACKING_SILENT_MS);
    expect(n).toMatchObject({ toUids: [HIDER] });
    expect(n!.body).toContain('pings');
    const paused = { ...round, state: 'PAUSED' as const, pauses: [{ id: 'p', kind: 'SAFETY' as const, startAt: T0 + 2 * MIN, endAt: null, phase: 'HEAD_START' as const, requestedByUid: SEEKER, confirmedByUid: null, reason: null }] };
    expect(trackingNudges(paused, m, T0 + 9 * MIN)).toEqual([]);
    expect(trackingNudges({ ...round, state: 'COMPLETED' }, m, T0 + 9 * MIN)).toEqual([]);
    // A phone that left the night is never nudged.
    m[HIDER]!.active = false;
    expect(trackingNudges(round, m, T0 + 9 * MIN)).toEqual([]);
  });
});
