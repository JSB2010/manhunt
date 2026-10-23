import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, type Harness, type TestUser } from '../integration/helpers.js';

/**
 * A phone whose owner sits out (ADR 0019) stays in the night but plays no round: it may
 * edit the night between rounds, and it can read nothing about the round that the
 * night's crews couldn't already see — no pins, no uploads, no post-round artifacts.
 */
let h: Harness;
let host: TestUser; // seeking crew B
let hider: TestUser; // hiding crew A
let bench: TestUser; // joined crew A, then sat out before the round
let sid: string;
let rid: string;

const HIDER_LAT = 39.761234;
const HIDER_LON = -104.977654;
const containsHiderCoords = (body: unknown) => /39\.7612|104\.9776/.test(JSON.stringify(body));

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  host = await h.createUser('Host');
  hider = await h.createUser('Hider');
  bench = await h.createUser('Bench');
  const s = await h.call(host, 'POST', '/v1/sessions', {
    title: 'Sitting out',
    scheduledDate: '2026-10-24',
    myTeam: 'B',
    teams: { A: { roster: [{ displayName: 'Ana' }] }, B: { roster: [{ displayName: 'Bo' }] } },
    firstHidingTeam: 'A',
    rules: { headStartSeconds: 300, pingIntervalSeconds: 300 },
  });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  sid = s.body.sessionId;
  rid = s.body.round.id;
  const code = (await h.call(host, 'POST', `/v1/sessions/${sid}/invites`, {})).body.code;
  for (const u of [hider, bench]) expect((await h.call(u, 'POST', '/v1/invites/redeem', { code, teamKey: 'A' })).status).toBe(200);
  // Bench sits out: their name moves to Sitting Out, and their phone with it.
  const v = (await h.call(host, 'GET', `/v1/sessions/${sid}`)).body;
  const me = v.session.teams.A.operators.find((o: any) => o.uid === bench.uid).personId;
  const a = v.session.teams.A.roster.filter((p: any) => p.personId !== me);
  const sat = await h.call(host, 'PATCH', `/v1/sessions/${sid}/setup`, { teams: { A: { roster: a } }, bench: v.session.teams.A.roster.filter((p: any) => p.personId === me) });
  expect(sat.status, JSON.stringify(sat.body)).toBe(200);
  for (const u of [host, hider, bench]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
  expect((await h.call(bench, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
  for (const u of [host, hider]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
  expect((await h.call(bench, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, {})).body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
  expect((await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, {})).status).toBe(200);
  const T0 = h.clock.now();
  for (let i = 1; i <= 4; i++) {
    h.clock.set(T0 + i * 30_000);
    await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now() - 1000, HIDER_LAT + i * 1e-6, HIDER_LON]]));
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('a phone sitting out', () => {
  it('sees no hider position anywhere during the round', async () => {
    const v = await h.call(bench, 'GET', `/v1/sessions/${sid}`);
    expect(v.status).toBe(200);
    expect(v.body.session.myTeam).toBeNull();
    expect(v.body.round).toMatchObject({ myRole: null, myTeam: null, pins: [], pingLog: [], captureRequest: null, myClaim: null });
    expect(containsHiderCoords(v.body)).toBe(false);
    expect(containsHiderCoords((await h.deps.db.doc(`sessions/${sid}/views/${bench.uid}`).get()).data())).toBe(false);
    expect((await h.call(bench, 'GET', `/v1/sessions/${sid}/rounds/${rid}/my-track`)).body.points ?? []).toEqual([]);
    for (const url of [`/v1/sessions/${sid}/rounds/${rid}/summary`, `/v1/sessions/${sid}/rounds/${rid}/routes`, `/v1/sessions/${sid}/analytics`, `/v1/export/sessions/${sid}.csv`]) {
      expect(containsHiderCoords((await h.call(bench, 'GET', url)).body)).toBe(false);
    }
  });

  it('cannot upload, claim, pause or abort in the round', async () => {
    const r = `/v1/sessions/${sid}/rounds/${rid}`;
    const up = await h.call(bench, 'POST', `${r}/location-batches`, batch(h.clock, [[h.clock.now() - 1000, 39.7, -104.9]]));
    expect(up.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    for (const [path, body] of [
      ['captures/init', {}],
      ['pause', { kind: 'SAFETY', reason: null }],
      ['abort', { reason: 'nope' }],
    ] as const) {
      const res = await h.call(bench, 'POST', `${r}/${path}`, body);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect((await h.call(bench, 'PATCH', `/v1/sessions/${sid}/setup`, { title: 'mid-round' })).body.error.code).toBe('GAME_CLOSED');
  });

  it('gets no post-round artifacts of a round it did not play, but may edit the night after it', async () => {
    expect((await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/abort`, { reason: 'Test complete', safety: false })).status).toBe(200);
    const routes = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(containsHiderCoords(routes.body)).toBe(true); // the round's own phones, post-round
    for (const path of ['summary', 'routes']) expect((await h.call(bench, 'GET', `/v1/sessions/${sid}/rounds/${rid}/${path}`)).status).toBe(404);
    expect((await h.call(bench, 'PATCH', `/v1/sessions/${sid}/setup`, { title: 'Round 2 soon' })).status).toBe(200);
    expect((await h.call(bench, 'POST', `/v1/sessions/${sid}/next-round`, {})).status).toBe(200);
  });
});
