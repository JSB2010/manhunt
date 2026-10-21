import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearEmulators, harness, type Harness } from './helpers.js';

/**
 * Server half of the auth / rate-limit fixes, over the real API + emulators:
 * a deleted account stays deleted while its last ID token is still valid,
 * idempotency replays only successes, and a 429 tells the app when to retry.
 */
let h: Harness;

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('auth resilience', () => {
  it('a still-valid token cannot re-provision a deleted account', async () => {
    const u = await h.createUser('Ghost');
    expect((await h.call(u, 'GET', '/v1/me')).status).toBe(200);
    const del = await h.call(u, 'DELETE', '/v1/me');
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect((await h.deps.db.doc(`deletedAccounts/${u.uid}`).get()).data()).toEqual({ uid: u.uid, deletedAt: h.clock.now() });

    // Same token, verified fine (ID tokens outlive the auth user by up to an hour).
    const again = await h.call(u, 'GET', '/v1/me');
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('UNAUTHENTICATED');
    expect((await h.deps.db.doc(`users/${u.uid}`).get()).exists).toBe(false);
    expect((await h.deps.db.collection('people').where('linkedUid', '==', u.uid).get()).empty).toBe(true);
  });

  it('idempotency stores only 2xx: a retry after a 4xx runs again', async () => {
    const u = await h.createUser('Retry');
    const key = randomUUID();
    const handle = `r_${randomUUID().slice(0, 8)}`;

    const bad = await h.call(u, 'PATCH', '/v1/me', { handle: 'x' }, { 'idempotency-key': key });
    expect(bad.status).toBe(400);
    expect((await h.deps.db.collection('idempotency').where('status', '==', 400).get()).empty).toBe(true);

    const ok = await h.call(u, 'PATCH', '/v1/me', { handle }, { 'idempotency-key': key });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.headers['idempotent-replay']).toBeUndefined();

    const replay = await h.call(u, 'PATCH', '/v1/me', { handle }, { 'idempotency-key': key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(ok.body);
  });

  it('a 4xx record stored before this fix is not replayed', async () => {
    const u = await h.createUser('Legacy');
    const key = randomUUID();
    const id = createHash('sha256').update(`${u.uid}:PATCH:/v1/me:/v1/me:${key}`).digest('hex');
    await h.deps.db.doc(`idempotency/${id}`).set({ status: 409, body: JSON.stringify({ error: { code: 'STALE_PHASE', message: 'old' } }), createdAt: h.clock.now() });

    const r = await h.call(u, 'PATCH', '/v1/me', { displayName: 'Legacy Two' }, { 'idempotency-key': key });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['idempotent-replay']).toBeUndefined();
    expect((await h.deps.db.doc(`idempotency/${id}`).get()).data()?.status).toBe(200);
  });

  it('rate-limited calls get 429 with Retry-After', async () => {
    const u = await h.createUser('Spammer');
    // `account` bucket: 10 per hour.
    for (let i = 0; i < 10; i++) expect((await h.call(u, 'DELETE', `/v1/sessions/missing-${i}`)).status).toBe(404);
    const limited = await h.call(u, 'DELETE', '/v1/sessions/missing-x');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('360');
    // Other buckets are unaffected.
    expect((await h.call(u, 'GET', '/v1/me')).status).toBe(200);
  });
});
