import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, type Harness, type TestUser } from './helpers.js';

/**
 * People make the crew (ADR 0019): one list of people per crew plus Sitting Out, phones that
 * follow their owners, people arriving late and leaving early, crews named after their people.
 */
let h: Harness;
let sasha: TestUser; // organizer, crew A
let marco: TestUser; // typed as "Marco Bellini" on crew B
let ezra: TestUser; // typed as "Ezra Holt", sitting out until he arrives
let sid: string;
let code: string;

const view = async (u: TestUser) => (await h.call(u, 'GET', `/v1/sessions/${sid}`)).body;
const names = (v: any, k: string) => (v.session.teams[k]?.roster ?? []).map((p: any) => p.displayName);
const phonesOf = (v: any, k: string) => (v.session.teams[k]?.operators ?? []).map((o: any) => o.uid);
const person = (v: any, name: string) =>
  [...Object.values(v.session.teams).flatMap((t: any) => t.roster), ...v.session.sittingOut.roster].find((p: any) => p.displayName === name);
const ref = (p: any) => ({ personId: p.personId, displayName: p.displayName });
const edit = (u: TestUser, body: unknown) => h.call(u, 'PATCH', `/v1/sessions/${sid}/setup`, body);

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  sasha = await h.createUser('Sasha Okafor');
  marco = await h.createUser('Marco');
  ezra = await h.createUser('Ezra Holt');
  const me = await h.call(sasha, 'GET', '/v1/me');
  const s = await h.call(sasha, 'POST', '/v1/sessions', {
    title: 'Fluid night',
    scheduledDate: '2026-10-24',
    myTeam: 'A',
    teams: {
      // Typed crew names are ignored: crews are named after their people.
      A: { name: 'Foxes', roster: [{ personId: me.body.profile.selfPersonId, displayName: 'Sasha Okafor' }, { displayName: 'Theo Marsh' }] },
      B: { name: 'Hounds', roster: [{ displayName: 'Marco Bellini' }, { displayName: 'Priya Nandan' }] },
    },
    bench: [{ displayName: 'Ezra Holt' }],
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120 },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  sid = s.body.sessionId;
  code = (await h.call(sasha, 'POST', `/v1/sessions/${sid}/invites`, {})).body.code;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('people make the crew (ADR 0019)', () => {
  it('names crews after their people; someone not here yet sits out', async () => {
    const v = await view(sasha);
    expect(v.session.teams.A.name).toBe('Sasha & Theo');
    expect(v.session.teams.B.name).toBe('Marco & Priya');
    expect(v.session.sittingOut).toEqual({ roster: [expect.objectContaining({ displayName: 'Ezra Holt' })], operators: [] });
    expect(phonesOf(v, 'A')).toEqual([sasha.uid]);
  });

  it('a phone joining as someone sitting out puts them on a crew', async () => {
    expect((await h.call(marco, 'POST', '/v1/invites/redeem', { code })).body.session.myTeam).toBe('B');
    const prev = await h.call(ezra, 'POST', '/v1/invites/preview', { code });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const ezraHolt = prev.body.sittingOut.find((p: any) => p.displayName === 'Ezra Holt');
    expect(prev.body.suggestedPersonId).toBe(ezraHolt.personId);
    const j = await h.call(ezra, 'POST', '/v1/invites/redeem', { code, teamKey: 'A', personId: ezraHolt.personId });
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    expect(j.body.session.myTeam).toBe('A');
    expect(names(j.body, 'A')).toEqual(['Sasha Okafor', 'Theo Marsh', 'Ezra Holt']);
    expect(j.body.session.teams.A.name).toBe('Sasha, Theo & Ezra');
    expect(j.body.session.sittingOut.roster).toEqual([]);
    const people = (await h.call(sasha, 'GET', '/v1/people')).body.people.map((p: any) => p.displayName);
    expect(people.filter((n: string) => n.startsWith('Ezra'))).toEqual(['Ezra Holt']); // no second Ezra
  });

  it('moving a person moves their phone', async () => {
    const v = await view(sasha);
    const r = await edit(sasha, {
      teams: {
        A: { roster: v.session.teams.A.roster.filter((p: any) => p.displayName !== 'Ezra Holt').map(ref) },
        B: { roster: [...v.session.teams.B.roster.map(ref), ref(person(v, 'Ezra Holt'))] },
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await view(ezra);
    expect(after.session.myTeam).toBe('B');
    expect(phonesOf(after, 'B')).toEqual([marco.uid, ezra.uid]);
    expect(after.session.teams.B.name).toBe('Marco, Priya & Ezra');
    const moved = (await h.deps.db.collection(`sessions/${sid}/events`).where('type', '==', 'OPERATOR_MOVED').get()).docs.map((d) => d.data().details);
    expect(moved).toContainEqual({ uid: ezra.uid, from: 'A', to: 'B' });
  });

  it('a person sitting out keeps their phone in the night as a spectator', async () => {
    const v = await view(sasha);
    const marcoB = person(v, 'Marco Bellini');
    const r = await edit(sasha, { teams: { B: { roster: v.session.teams.B.roster.filter((p: any) => p.personId !== marcoB.personId).map(ref) } }, bench: [ref(marcoB)] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const mv = await view(marco);
    expect(mv.session.myTeam).toBeNull();
    expect(mv.session.sittingOut.operators).toEqual([expect.objectContaining({ uid: marco.uid, personId: marcoB.personId, isMe: true })]);
    expect(mv.session.teams.B.name).toBe('Priya & Ezra');
    // No Ready from the bench; but crews, the night code and the next round are anyone's in the night.
    await h.call(marco, 'POST', `/v1/sessions/${sid}/consent`, consentBody);
    const ready = await h.call(marco, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(ready.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    expect((await h.call(marco, 'POST', `/v1/sessions/${sid}/invites`, {})).status).toBe(200);
    expect((await edit(marco, { title: 'Fluid night!' })).status).toBe(200);
    // Opening the code again doesn't pull them onto a crew.
    expect((await h.call(marco, 'POST', '/v1/invites/redeem', { code })).body.session.myTeam).toBeNull();
  });

  it('plays a round without the people sitting out: not in its rosters, no pins, no uploads', async () => {
    for (const u of [sasha, ezra]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    const rid = (await view(sasha)).round.id;
    for (const u of [sasha, ezra]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
    h.clock.advance(2000);
    const start = await h.call(sasha, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const round = (await h.deps.db.doc(`sessions/${sid}/rounds/${rid}`).get()).data()!;
    expect(round.rosterSnapshot.B.map((p: any) => p.displayName)).toEqual(['Priya Nandan', 'Ezra Holt']);
    expect(round.teamNames).toEqual({ A: 'Sasha & Theo', B: 'Priya & Ezra' });
    expect(Object.values(round.operatorsByTeam).flat()).not.toContain(marco.uid);
    const mv = await view(marco);
    expect(mv.round).toMatchObject({ myRole: null, pins: [], pingLog: [] });
    const up = await h.call(marco, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now() - 1000, 39.7, -104.9]]));
    expect(up.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    expect((await edit(marco, { title: 'mid-round' })).body.error.code).toBe('GAME_CLOSED');
    expect((await h.call(sasha, 'POST', `/v1/sessions/${sid}/rounds/${rid}/abort`, { reason: 'test' })).status).toBe(200);
  });

  it('people leave: a name just goes, a phone owner takes their phone, the organizer can only sit out', async () => {
    const v = await view(sasha);
    const [sashaO, theo, priya, ezraH, marcoB] = ['Sasha Okafor', 'Theo Marsh', 'Priya Nandan', 'Ezra Holt', 'Marco Bellini'].map((n) => ref(person(v, n)));
    // Theo goes home (no phone), Marco is back, Ezra leaves with his phone.
    const r = await edit(sasha, { teams: { A: { roster: [sashaO] }, B: { roster: [priya, marcoB] } }, bench: [] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await view(sasha);
    expect(names(after, 'A')).toEqual(['Sasha Okafor']);
    expect(after.session.teams.A.name).toBe('Sasha');
    expect(phonesOf(after, 'B')).toEqual([marco.uid]);
    expect((await h.call(ezra, 'GET', `/v1/sessions/${sid}`)).status).toBe(404);
    const removed = (await h.deps.db.collection(`sessions/${sid}/events`).where('type', '==', 'OPERATOR_REMOVED').get()).docs.map((d) => d.data().details);
    expect(removed).toContainEqual({ uid: ezra.uid, from: 'B' });
    // The organizer can't be removed, but can sit out.
    const gone = await edit(marco, { teams: { A: { roster: [] } } });
    expect(gone.body.error.code).toBe('FORBIDDEN');
    expect((await edit(marco, { teams: { A: { roster: [theo] } }, bench: [sashaO] })).status).toBe(200);
    expect((await view(sasha)).session.myTeam).toBeNull();
    // Someone on a crew and sitting out at once is a client error.
    expect((await edit(sasha, { teams: { A: { roster: [theo, sashaO] } }, bench: [sashaO] })).status).toBe(400);
    // An app that doesn't know about Sitting Out lists her on a crew: that wins.
    expect((await edit(sasha, { teams: { A: { name: 'Crew A', roster: [sashaO, theo] } } })).status).toBe(200);
    const back = await view(sasha);
    expect(back.session.myTeam).toBe('A');
    expect(back.session.sittingOut.roster).toEqual([]);
    expect(back.session.teams.A.name).toBe('Sasha & Theo');
  });

  it('a phone taken out leaves its owner playing without it', async () => {
    const r = await edit(sasha, { moves: [{ uid: marco.uid, teamKey: null }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await view(sasha);
    expect(names(v, 'B')).toEqual(['Priya Nandan', 'Marco Bellini']);
    expect(phonesOf(v, 'B')).toEqual([]);
    expect((await h.call(marco, 'GET', `/v1/sessions/${sid}`)).status).toBe(404);
    // Back with the code, the phone finds its owner's name again.
    const j = await h.call(marco, 'POST', '/v1/invites/redeem', { code });
    expect(j.body.session.myTeam).toBe('B');
    expect(names(j.body, 'B')).toEqual(['Priya Nandan', 'Marco Bellini']);
  });

  it('messages agree with how many people are on a crew', async () => {
    const sent = h.notifier.sent.length;
    const nr = await h.call(marco, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'B' });
    expect(nr.status, JSON.stringify(nr.body)).toBe(200);
    const next = h.notifier.sent.slice(sent).find((n) => n.kind === 'NEXT_ROUND')!;
    expect(next.body).toBe('Priya & Marco hide, Sasha & Theo seek. Tap Ready.');
    expect(await edit(sasha, { teams: { A: { roster: [ref(person(await view(sasha), 'Sasha Okafor'))] } }, bench: [ref(person(await view(sasha), 'Theo Marsh'))] })).toMatchObject({ status: 200 });
    const sent2 = h.notifier.sent.length;
    await h.call(sasha, 'POST', `/v1/sessions/${sid}/complete`);
    expect(h.notifier.sent.slice(sent2).find((n) => n.kind === 'SESSION_COMPLETED')!.toUids).toEqual([marco.uid]);
  });

  it('the scorecard says what changed before each round', async () => {
    const a = await h.call(sasha, 'GET', `/v1/sessions/${sid}/analytics`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.scorecard.rounds).toHaveLength(1);
    expect(a.body.scorecard.changes).toEqual([]);
    expect(a.body.scorecard.matchups).toEqual([expect.objectContaining({ rounds: [1] })]);
    expect(a.body.scorecard.people).toEqual([]); // the only round was aborted
  });
});
