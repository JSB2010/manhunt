import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, WORKER_SECRET, type Harness, type TestUser } from '../integration/helpers.js';

/**
 * Hard negative tests (spec §11 "Hard negative test", §15.1): a malicious
 * seeker — including one who is also the session host — cannot obtain the
 * hiding crew's live or unreleased location through any API, role smuggling,
 * worker endpoint, photo path or Firestore path.
 */
let h: Harness;
let host: TestUser; // host is the SEEKER in round 1 (no spying privilege)
let hider: TestUser;
let outsider: TestUser;
let sid: string;
let rid: string;
let T0: number;

const HIDER_LAT = 39.751234;
const HIDER_LON = -104.987654;

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  host = await h.createUser('Host');
  hider = await h.createUser('Hider');
  outsider = await h.createUser('Outsider');
  const s = await h.call(host, 'POST', '/v1/sessions', {
    title: 'Security night',
    scheduledDate: '2026-10-17',
    myTeam: 'B',
    teams: { A: { name: 'Foxes', roster: [{ displayName: 'Ana' }] }, B: { name: 'Hounds', roster: [{ displayName: 'Bo' }] } },
    rules: { initialHidingTeam: 'A', headStartSeconds: 300, pingIntervalSeconds: 300 },
  });
  sid = s.body.sessionId;
  rid = s.body.round.id;
  const inv = await h.call(host, 'POST', `/v1/sessions/${sid}/invites`, {});
  await h.call(hider, 'POST', '/v1/invites/redeem', { code: inv.body.code });
  for (const u of [host, hider]) {
    await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody);
    await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
  }
  const st = await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, {});
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  T0 = h.clock.now();
  // Hider uploads distinctive positions during head start.
  for (let i = 1; i <= 9; i++) {
    h.clock.set(T0 + i * 30_000);
    await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now() - 1000, HIDER_LAT + i * 1e-6, HIDER_LON]]));
  }
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const containsHiderCoords = (body: unknown) => /39\.7512|104\.9876/.test(JSON.stringify(body));

describe('seeker (also host) cannot see the hider during the round', () => {
  it('session view, list and Firestore view contain no hider coordinates before any release', async () => {
    const v = await h.call(host, 'GET', `/v1/sessions/${sid}`);
    expect(v.body.round.myRole).toBe('SEEKING');
    expect(v.body.round.pins).toEqual([]);
    expect(containsHiderCoords(v.body)).toBe(false);
    expect(containsHiderCoords((await h.call(host, 'GET', '/v1/sessions')).body)).toBe(false);
    const fsv = (await h.deps.db.doc(`sessions/${sid}/views/${host.uid}`).get()).data();
    expect(containsHiderCoords(fsv)).toBe(false);
  });

  it('my-track returns only the caller’s own samples', async () => {
    const r = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/my-track`);
    expect(r.status).toBe(200);
    expect(r.body.points).toEqual([]);
    const own = await h.call(hider, 'GET', `/v1/sessions/${sid}/rounds/${rid}/my-track`);
    expect(own.body.points.length).toBe(9);
  });

  it('summary, routes, analytics and exports reveal nothing while active', async () => {
    const sum = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    expect(sum.status).toBe(409);
    expect(sum.body.error.code).toBe('GAME_NOT_READY');
    const routes = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(routes.body.error.code).toBe('GAME_NOT_READY');
    for (const url of [`/v1/sessions/${sid}/analytics`, `/v1/export/sessions/${sid}.json`, `/v1/export/sessions/${sid}.csv`]) {
      const r = await h.call(host, 'GET', url);
      expect(containsHiderCoords(r.body)).toBe(false);
    }
  });

  it('there is no raw-locations endpoint and unknown routes 404', async () => {
    for (const url of ['/raw-locations', `/v1/sessions/${sid}/rounds/${rid}/points`, `/v1/sessions/${sid}/rounds/${rid}/locations`]) {
      expect((await h.call(host, 'GET', url)).status).toBe(404);
    }
  });

  it('role/team smuggling in payloads is rejected', async () => {
    const r = await h.call(host, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight(), role: 'HIDING', teamKey: 'A' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    const b = batch(h.clock, [[h.clock.now(), 1, 1]]) as Record<string, unknown>;
    const smug = await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, { ...b, operatorUid: hider.uid });
    expect(smug.status).toBe(400);
    const setup = await h.call(host, 'PATCH', `/v1/sessions/${sid}/setup`, { teams: { A: { operatorUid: host.uid } } });
    expect(setup.status).toBe(400);
  });

  it('seeker uploads are stored as SEEKING and can never become hider pings', async () => {
    // Host (seeker) uploads a point at a hider-like coordinate right before the deadline.
    h.clock.set(T0 + 5 * MIN - 2000);
    await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now() - 500, 40.0, -105.0]]));
    h.clock.set(T0 + 5 * MIN);
    await h.tick(sid, rid);
    const v = await h.call(host, 'GET', `/v1/sessions/${sid}`);
    expect(v.body.round.state).toBe('CHASE');
    expect(v.body.round.pins).toHaveLength(1);
    expect(v.body.round.pins[0].latitude).not.toBe(40.0);
    // The released pin is the hider's most recent eligible sample (recorded T0+4:29, during head start).
    expect(v.body.round.pins[0].latitude).toBeCloseTo(HIDER_LAT + 9e-6, 7);
    expect(v.body.round.pins[0].ageSeconds).toBe(31);
  });

  it('late (offline) hider uploads are never revealed retroactively', async () => {
    // Hider goes "offline" for the 5 min before ping 1; batch arrives after the deadline.
    const deadline = T0 + 10 * MIN;
    h.clock.set(deadline);
    await h.tick(sid, rid);
    let v = await h.call(host, 'GET', `/v1/sessions/${sid}`);
    const p1 = v.body.round.pingLog.find((p: any) => p.index === 1);
    expect(p1.status).toBe('NO_FRESH_FIX');
    // Pins still show the older ping 0 with its original timestamp, not a fake fresh one.
    expect(v.body.round.pins.map((p: any) => p.index)).toEqual([0]);
    h.clock.set(deadline + 30_000);
    const late = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[deadline - 5000, 39.7777, -104.9]]));
    expect(late.status).toBe(200);
    await h.tick(sid, rid);
    v = await h.call(host, 'GET', `/v1/sessions/${sid}`);
    expect(JSON.stringify(v.body)).not.toContain('39.7777');
  });

  it('seeker cannot decide claims; hider cannot submit them; outsider cannot touch the round', async () => {
    const hInit = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
    expect(hInit.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    const init = await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
    await h.call(host, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
    await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId });
    const self = await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' });
    expect(self.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    for (const [m, url] of [
      ['GET', `/v1/sessions/${sid}`],
      ['GET', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/photo`],
      ['GET', `/v1/sessions/${sid}/rounds/${rid}/my-track`],
      ['POST', `/v1/sessions/${sid}/rounds/${rid}/pause`],
    ] as const) {
      const r = await h.call(outsider, m, url, m === 'POST' ? { kind: 'SAFETY' } : undefined);
      expect([403, 404]).toContain(r.status);
    }
    const out = await h.call(outsider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now(), 39, -104]]));
    expect([403, 404]).toContain(out.status);
    // Reject to keep playing.
    await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'REJECT' });
  });

  it('unauthenticated and forged tokens are rejected', async () => {
    expect((await h.call(null, 'GET', `/v1/sessions/${sid}`)).status).toBe(401);
    expect((await h.call({ ...host, token: 'not-a-token' }, 'GET', `/v1/sessions/${sid}`)).status).toBe(401);
  });

  it('worker endpoints refuse Firebase client tokens and anonymous calls', async () => {
    for (const url of ['/internal/rounds/tick', '/internal/pings/fire', '/internal/watchdog/repair', '/internal/retention/sweep']) {
      const anon = await h.worker.inject({ method: 'POST', url, payload: { sessionId: sid, roundId: rid } });
      expect(anon.statusCode).toBe(401);
      const firebaseToken = await h.worker.inject({ method: 'POST', url, headers: { authorization: `Bearer ${host.token}` }, payload: { sessionId: sid, roundId: rid } });
      expect(firebaseToken.statusCode).toBe(403);
      const wrongSecret = await h.worker.inject({ method: 'POST', url, headers: { 'x-worker-secret': `${WORKER_SECRET}x` }, payload: { sessionId: sid, roundId: rid } });
      expect(wrongSecret.statusCode).toBe(401);
    }
    // The public API has no /internal routes at all.
    expect((await h.call(host, 'POST', '/internal/rounds/tick', { sessionId: sid, roundId: rid })).status).toBe(404);
  });

  it('concurrent/retried ticks never publish duplicate pings', async () => {
    const before = (await h.deps.db.collection(`sessions/${sid}/rounds/${rid}/pings`).get()).size;
    const r = (await h.deps.db.doc(`sessions/${sid}/rounds/${rid}`).get()).data()!;
    // Jump past the next deadline and fire 6 ticks at once (Cloud Tasks retries + watchdog).
    h.clock.set((r.nextWakeAt as number) + 1000);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => h.tick(sid, rid)));
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    const pings = await h.deps.db.collection(`sessions/${sid}/rounds/${rid}/pings`).get();
    expect(pings.size).toBe(before + 1);
    const round = (await h.deps.db.doc(`sessions/${sid}/rounds/${rid}`).get()).data()!;
    expect(new Set(round.pings.map((p: any) => p.index)).size).toBe(round.pings.length);
  });

  it('idempotency keys replay the original response', async () => {
    const key = 'pause-req-0001';
    const a = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'MANUAL', reason: 'water' }, { 'idempotency-key': key });
    const b = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'MANUAL', reason: 'water' }, { 'idempotency-key': key });
    expect(a.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.pendingRequest).toBe(a.body.pendingRequest);
  });

  it('after completion both operators can see both routes; outsiders still cannot', async () => {
    const ab = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/abort`, { reason: 'Test complete', safety: false });
    expect(ab.status, JSON.stringify(ab.body)).toBe(200);
    const routes = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(routes.status, JSON.stringify(routes.body)).toBe(200);
    expect(containsHiderCoords(routes.body)).toBe(true); // post-round, consented
    expect((await h.call(outsider, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`)).status).toBe(404);
  });

  it('operator deletes their own track: points, routes and photos are removed for both viewers', async () => {
    const del = await h.call(hider, 'DELETE', `/v1/sessions/${sid}/my-data`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.pointsDeleted).toBeGreaterThan(0);
    const routes = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(routes.body.teams.A.deleted).toBe(true);
    expect(containsHiderCoords(routes.body)).toBe(false);
    const pts = await h.deps.db.collection(`sessions/${sid}/rounds/${rid}/points`).where('operatorUid', '==', hider.uid).get();
    expect(pts.size).toBe(0);
    // Released pins (hider positions) are redacted from the summary and both views too.
    const sum = await h.call(host, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    expect(sum.body.pings.length).toBeGreaterThan(0);
    expect(containsHiderCoords(sum.body)).toBe(false);
    expect(containsHiderCoords((await h.call(host, 'GET', `/v1/sessions/${sid}`)).body)).toBe(false);
  });

  it('organizer deletes the night: all documents and stored objects are gone', async () => {
    const del = await h.call(host, 'DELETE', `/v1/sessions/${sid}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await h.deps.db.doc(`sessions/${sid}`).get()).exists).toBe(false);
    expect((await h.deps.db.collection(`sessions/${sid}/rounds`).get()).size).toBe(0);
    expect(await h.deps.store.deletePrefix(`sessions/${sid}/`)).toBe(0);
    expect((await h.call(hider, 'GET', `/v1/sessions/${sid}`)).status).toBe(404);
  });
});

describe('invites and accounts', () => {
  it('expired invites are rejected; targeted invites only work for the target', async () => {
    const a = await h.createUser('Ann');
    const b = await h.createUser('Ben');
    const s = await h.call(a, 'POST', '/v1/sessions', { title: 'x', scheduledDate: '2026-10-18', myTeam: 'A', teams: { A: { name: 'A', roster: [] }, B: { name: 'B', roster: [] } } });
    const inv = await h.call(a, 'POST', `/v1/sessions/${s.body.sessionId}/invites`, {});
    h.clock.advance(2 * 3600_000);
    expect((await h.call(b, 'POST', '/v1/invites/redeem', { code: inv.body.code })).body.error.code).toBe('INVITE_INVALID');
    // Direct invites require friendship.
    const direct = await h.call(a, 'POST', `/v1/sessions/${s.body.sessionId}/invites`, { targetUid: b.uid });
    expect(direct.body.error.code).toBe('FORBIDDEN');
  });

  it('account deletion removes profile, social graph and auth user', async () => {
    const u = await h.createUser('Gone');
    const v = await h.createUser('Stay');
    await h.call(u, 'PATCH', '/v1/me', { handle: 'gone_user' });
    await h.call(v, 'POST', '/v1/friends/requests', { handle: 'gone_user' });
    const reqs = await h.call(u, 'GET', '/v1/friends/requests');
    await h.call(u, 'POST', `/v1/friends/requests/${reqs.body.incoming[0].requestId}/respond`, { accept: true });
    const del = await h.call(u, 'DELETE', '/v1/me');
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await h.deps.db.doc(`users/${u.uid}`).get()).exists).toBe(false);
    expect((await h.deps.db.doc('handles/gone_user').get()).exists).toBe(false);
    expect((await h.call(v, 'GET', '/v1/friends')).body.friends).toEqual([]);
  });
});
