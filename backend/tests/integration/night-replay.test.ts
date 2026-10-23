import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameService } from '../../src/services/gameService.js';
import { FINALIZE_LEASE_MS } from '../../src/services/finalize.js';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * Replays what went wrong on the night of 2026-10-22 (5 rounds, 7 phones, crews
 * reshuffled between rounds) against the emulators:
 *  - accounts named "Sasha", "Marco", "rileyquinn" joined crews whose organizer had typed
 *    "Sasha Okafor", "Marco Bellini", "Riley Quinn": every one became a second person;
 *  - phones moved between crews but their owners' names stayed behind, so people were
 *    credited with the wrong crew's rounds, and a new crew hid with an empty roster;
 *  - deleting that crew logged its phones as moved "from null";
 *  - at every catch, the decision and each phone's final upload recomputed the recap at
 *    the same time (2–9 s each);
 *  - a hiding phone left in a pocket tracked nothing for 8½ minutes.
 */
let h: Harness;
let jordan: TestUser; // organizer, Crew A
let sasha: TestUser; // account "Sasha" — typed as "Sasha Okafor" on Crew A
let marco: TestUser; // account "Marco" — typed as "Marco Bellini" on Crew B
let riley: TestUser; // account "rileyquinn" — typed as "Riley Quinn" on Crew B
let sid: string;
let code: string;

const roster = (v: any, k: string) => (v.session.teams[k]?.roster ?? []).map((p: any) => p.displayName);
const view = async (u: TestUser) => (await h.call(u, 'GET', `/v1/sessions/${sid}`)).body;

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  jordan = await h.createUser('Jordan Avery');
  sasha = await h.createUser('Sasha');
  marco = await h.createUser('Marco');
  riley = await h.createUser('rileyquinn');
  const me = await h.call(jordan, 'GET', '/v1/me');
  const s = await h.call(jordan, 'POST', '/v1/sessions', {
    title: 'Manhunt night',
    scheduledDate: '2026-10-22',
    myTeam: 'A',
    teams: {
      A: { name: 'Crew A', roster: [{ personId: me.body.profile.selfPersonId, displayName: 'Jordan Avery' }, { displayName: 'Sasha Okafor' }, { displayName: 'Dana Whitfield' }] },
      B: { name: 'Crew B', roster: [{ displayName: 'Marco Bellini' }, { displayName: 'Riley Quinn' }, { displayName: 'Ezra Holt' }] },
    },
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120 },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  sid = s.body.sessionId;
  code = (await h.call(jordan, 'POST', `/v1/sessions/${sid}/invites`, {})).body.code;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('replay of 2026-10-22', () => {
  it('a joining phone takes the name typed for its owner instead of adding a second person', async () => {
    const prev = await h.call(sasha, 'POST', '/v1/invites/preview', { code });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const sashaOkafor = prev.body.teams.A.roster.find((p: any) => p.displayName === 'Sasha Okafor').personId;
    expect(prev.body.suggestedPersonId).toBe(sashaOkafor);
    // Jordan's phone already plays as Jordan Avery.
    expect(prev.body.claimedPersonIds).toHaveLength(1);

    // Sasha joins without picking a crew: he lands on the crew that lists him.
    const a = await h.call(sasha, 'POST', '/v1/invites/redeem', { code });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.session.myTeam).toBe('A');
    expect(roster(a.body, 'A')).toEqual(['Jordan Avery', 'Sasha Okafor', 'Dana Whitfield']);
    expect(a.body.session.teams.A.operators.find((o: any) => o.uid === sasha.uid).personId).toBe(sashaOkafor);

    const d = await h.call(riley, 'POST', '/v1/invites/redeem', { code, teamKey: 'B' });
    expect(roster(d.body, 'B')).toEqual(['Marco Bellini', 'Riley Quinn', 'Ezra Holt']);

    // Marco picks his name explicitly ("That's me"), and picks it from the list in the app.
    const jp = await h.call(marco, 'POST', '/v1/invites/preview', { code });
    const marcoB = jp.body.teams.B.roster.find((p: any) => p.displayName === 'Marco Bellini').personId;
    expect(jp.body.suggestedPersonId).toBe(marcoB);
    const taken = await h.call(marco, 'POST', '/v1/invites/redeem', { code, teamKey: 'B', personId: sashaOkafor });
    expect(taken.status).toBe(400); // another phone plays as Sasha Okafor
    const j = await h.call(marco, 'POST', '/v1/invites/redeem', { code, teamKey: 'B', personId: marcoB });
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    expect(roster(j.body, 'B')).toEqual(['Marco Bellini', 'Riley Quinn', 'Ezra Holt']);
    const people = await h.call(jordan, 'GET', '/v1/people');
    expect(people.body.people.map((p: any) => p.displayName).sort()).toEqual(['Dana Whitfield', 'Ezra Holt', 'Jordan Avery', 'Marco Bellini', 'Riley Quinn', 'Sasha Okafor']);
  });

  it('a phone moved to another crew takes its owner’s name along; a new crew is played under its people’s names', async () => {
    // As at 20:42: Marco's phone to A, Sasha's to B, sent by an app that leaves the rosters as they were.
    const v0 = await view(jordan);
    const unchanged = Object.fromEntries(['A', 'B'].map((k) => [k, { name: v0.session.teams[k].name, roster: v0.session.teams[k].roster }]));
    const mv = await h.call(jordan, 'PATCH', `/v1/sessions/${sid}/setup`, {
      teams: unchanged,
      moves: [
        { uid: marco.uid, teamKey: 'A' },
        { uid: sasha.uid, teamKey: 'B' },
      ],
    });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    let v = await view(jordan);
    expect(roster(v, 'A')).toEqual(['Jordan Avery', 'Dana Whitfield', 'Marco Bellini']);
    expect(roster(v, 'B')).toEqual(['Riley Quinn', 'Ezra Holt', 'Sasha Okafor']);

    // As at 21:43: a third crew made of two moved phones, created with no names.
    const add = await h.call(jordan, 'PATCH', `/v1/sessions/${sid}/setup`, {
      teams: { C: { name: 'Crew C', roster: [] } },
      moves: [
        { uid: marco.uid, teamKey: 'C' },
        { uid: riley.uid, teamKey: 'C' },
      ],
    });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    v = await view(jordan);
    expect(roster(v, 'C')).toEqual(['Marco Bellini', 'Riley Quinn']);

    // As at 22:44: crew C removed. The app sent its phones to the emptiest crews; their people go with them.
    const del = await h.call(jordan, 'PATCH', `/v1/sessions/${sid}/setup`, {
      teams: { C: null },
      moves: [
        { uid: marco.uid, teamKey: 'A' },
        { uid: riley.uid, teamKey: 'B' },
      ],
    });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    v = await view(jordan);
    expect(v.session.teams.C).toBeUndefined();
    for (const [u, name] of [
      [marco, 'Marco Bellini'],
      [riley, 'Riley Quinn'],
    ] as const) {
      const k = ['A', 'B'].find((x) => v.session.teams[x].operators.some((o: any) => o.uid === u.uid))!;
      expect(roster(v, k)).toContain(name);
    }
    const events = await h.deps.db.collection('sessions').doc(sid).collection('events').where('type', '==', 'OPERATOR_MOVED').get();
    const moved = events.docs.map((d) => d.data().details);
    expect(moved.filter((x) => x.from === null)).toEqual([]);
    expect(moved.filter((x) => x.from === 'C').map((x) => x.uid).sort()).toEqual([marco.uid, riley.uid].sort());
  });

  it('round results are credited to the people actually on each crew; briefs name crews by their people', async () => {
    // Put Marco back on B with Riley, then play a round with B hiding.
    expect((await h.call(jordan, 'PATCH', `/v1/sessions/${sid}/setup`, { moves: [{ uid: marco.uid, teamKey: 'B' }, { uid: riley.uid, teamKey: 'B' }, { uid: sasha.uid, teamKey: 'A' }] })).status).toBe(200);
    for (const u of [jordan, sasha, marco, riley]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    const nr = await h.call(jordan, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'B' });
    const rid = nr.body.round.id;
    h.clock.advance(1000);
    for (const u of [jordan, marco]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
    h.clock.advance(2000);
    expect((await h.call(jordan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true })).status).toBe(200);
    const T0 = h.clock.now();
    const round = (await h.deps.db.doc(`sessions/${sid}/rounds/${rid}`).get()).data()!;
    const names = (k: string) => round.rosterSnapshot[k].map((p: any) => p.displayName).sort();
    expect(names('B')).toEqual(['Ezra Holt', 'Marco Bellini', 'Riley Quinn']);
    expect(names('A')).toEqual(['Dana Whitfield', 'Jordan Avery', 'Sasha Okafor']);

    // Nudge: Marco's phone (hiding) never reports after the start; Riley's does.
    const game = new GameService(h.deps);
    h.clock.set(T0 + 30_000);
    await h.call(riley, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[T0 + 20_000, 39.7, -104.9]]));
    await h.call(jordan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[T0 + 20_000, 39.69, -104.9]]));
    await h.call(sasha, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[T0 + 20_000, 39.69, -104.9]]));
    h.clock.set(T0 + 61_000);
    const sentBefore = h.notifier.sent.length;
    const report = await game.watchdog();
    expect(report.nudged).toBe(1);
    const nudges = h.notifier.sent.slice(sentBefore).filter((n) => n.kind === 'TRACKING_NUDGE');
    expect(nudges.map((n) => n.toUids)).toEqual([[marco.uid]]);
    expect((await game.watchdog()).nudged).toBe(0); // once, not every minute

    // Play it out: hiders upload, the chase starts, Jordan claims and Marco confirms.
    for (let t = T0; t < T0 + 3 * MIN; t += 20_000) {
      h.clock.set(t + 20_000);
      for (const u of [marco, riley]) await h.call(u, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[t + 5_000, 39.7 + (t - T0) * 1e-9, -104.9]]));
      if (t === T0 + 2 * MIN - 20_000) {
        h.clock.set(T0 + 2 * MIN);
        await h.tick(sid, rid);
      }
    }
    // A phone retrying an upload while the first attempt is still in flight sends the same points
    // twice at once: both succeed, and each point is stored once.
    const twice = batch(h.clock, [[h.clock.now() - 2_000, 39.7, -104.9], [h.clock.now() - 1_000, 39.7001, -104.9]]);
    const [first, retry] = await Promise.all([0, 1].map(() => h.call(riley, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, twice)));
    expect([first!.status, retry!.status], JSON.stringify([first!.body, retry!.body])).toEqual([200, 200]);
    expect(first!.body.accepted + retry!.body.accepted).toBe(2);
    expect(first!.body.duplicates + retry!.body.duplicates).toBe(2);

    // Seekers have queued fixes, as phones on the 90-second seeker cadence do at the catch.
    const pending = (u: TestUser, lon: number) => batch(h.clock, [[h.clock.now() - 40_000, 39.69, lon], [h.clock.now() - 20_000, 39.691, lon], [h.clock.now() - 1_000, 39.692, lon]]);
    const init = await h.call(jordan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
    await h.call(jordan, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
    expect((await h.call(jordan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId })).status).toBe(200);
    h.clock.advance(10_000);
    // The decision and every phone's final upload land together.
    const [decision, ...uploads] = await Promise.all([
      h.call(marco, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' }),
      h.call(jordan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, pending(jordan, -104.95)),
      h.call(sasha, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, pending(sasha, -104.96)),
    ]);
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    for (const u of uploads) expect(u.status, JSON.stringify(u.body)).toBe(200);

    // One recap, computed from every point that reached the server; no lease left behind.
    const points = (await h.deps.db.collection(`sessions/${sid}/rounds/${rid}/points`).get()).size;
    const route = (await h.deps.db.doc(`sessions/${sid}/routes/${rid}`).get()).data()!;
    const counted = Object.values(route.teams).reduce((n: number, t: any) => n + t.sampleCount, 0) as number;
    const r = (await h.deps.db.doc(`sessions/${sid}/rounds/${rid}`).get()).data()!;
    expect(r.summaryReady).toBe(true);
    expect((await h.deps.db.doc(`sessions/${sid}/rounds/${rid}/locks/finalize`).get()).exists).toBe(false);
    // Each crew's route is one phone's track: the best-covered phones' samples are all in.
    const bySource = Object.values(r.routeSourceUids) as string[];
    const sourcePoints = await Promise.all(bySource.map(async (u) => (await h.deps.db.collection(`sessions/${sid}/rounds/${rid}/points`).where('operatorUid', '==', u).get()).size));
    expect(counted).toBe(sourcePoints.reduce((a, b) => a + b, 0));
    expect(points).toBeGreaterThanOrEqual(counted);
    // One raw-track archive per phone: superseded revisions are removed.
    const [files] = await (h.deps.store as any).bucket.getFiles({ prefix: `sessions/${sid}/rounds/${rid}/tracks/` });
    const perPhone = new Map<string, number>();
    for (const f of files) perPhone.set(f.name.split('/')[5], (perPhone.get(f.name.split('/')[5]) ?? 0) + 1);
    expect([...perPhone.values()].every((n) => n === 1)).toBe(true);
    expect(perPhone.size).toBe(4);

    // The recap timeline is the round, not the lobby before it.
    const sum = await h.call(jordan, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    const types = sum.body.timeline.map((e: any) => e.type);
    expect(types[0]).toBe('ROUND_STARTED');
    expect(types).not.toContain('READY_CHANGED');
    expect(types).not.toContain('SETUP_EDITED');

    // Briefs carry the crew names of the round: its people (ADR 0019).
    const after = await view(jordan);
    expect(after.previousRounds.at(-1).teamNames).toEqual({ A: 'Jordan, Dana & Sasha', B: 'Ezra, Riley & Marco' });

    // People are credited with their own crew's round: Marco hid, Sasha sought.
    const people = (await h.call(jordan, 'GET', '/v1/people')).body.people;
    const stats = async (name: string) => (await h.call(jordan, 'GET', `/v1/analytics/people/${people.find((p: any) => p.displayName === name).id}`)).body.analytics;
    expect(await stats('Marco Bellini')).toMatchObject({ roundsCrewHid: 1, roundsCrewSought: 0 });
    expect(await stats('Sasha Okafor')).toMatchObject({ roundsCrewHid: 0, roundsCrewSought: 1 });
  });

  it('a recap request while another computes it returns at once; the holder runs once more', async () => {
    const rid = (await view(jordan)).previousRounds.at(-1).roundId;
    const lock = h.deps.db.doc(`sessions/${sid}/rounds/${rid}/locks/finalize`);
    await lock.set({ token: 'someone-else', until: h.clock.now() + FINALIZE_LEASE_MS, rerun: false });
    const { finalizeRound } = await import('../../src/services/finalize.js');
    const before = (await h.deps.db.doc(`sessions/${sid}/routes/${rid}`).get()).data()!.revision;
    await finalizeRound(h.deps, sid, rid, { force: true });
    expect((await h.deps.db.doc(`sessions/${sid}/routes/${rid}`).get()).data()!.revision).toBe(before);
    expect((await lock.get()).data()).toMatchObject({ token: 'someone-else', rerun: true });
    // A lease past its time is taken over (a crashed holder).
    h.clock.advance(FINALIZE_LEASE_MS + 1);
    await finalizeRound(h.deps, sid, rid, { force: true });
    expect((await h.deps.db.doc(`sessions/${sid}/routes/${rid}`).get()).data()!.revision).toBe(before + 1);
    expect((await lock.get()).exists).toBe(false);
  });
});
