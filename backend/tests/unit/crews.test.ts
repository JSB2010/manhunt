import { describe, expect, it } from 'vitest';
import { crewOfPerson, matchRosterPerson, movePersonToCrew, ownerPersonId } from '../../src/domain/crews.js';
import { startRound, trackingNudges, TRACKING_NUDGE_AFTER_MS, TRACKING_NUDGE_EVERY_MS, TRACKING_SILENT_MS } from '../../src/domain/engine.js';
import type { SessionDoc } from '../../src/domain/types.js';
import { allPhones, health, HIDER, members, MIN, readyRound, SEEKER, session, T0 } from './fixtures.js';

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
