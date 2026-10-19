import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * Edge cases over the real API + emulators: time cap (censored), claim expiry via the
 * worker, joint post-game dispute resolution, manual/safety pauses with both-side
 * resume, host role override, consent withdrawal aborting a round, and rule changes
 * making the night "not directly comparable".
 */
let h: Harness;
let a: TestUser; // host, Crew A
let b: TestUser; // Crew B
let sid: string;
let rid: string;

async function view(u: TestUser) {
  return (await h.call(u, 'GET', `/v1/sessions/${sid}`)).body;
}

async function readyStart(ack = false) {
  h.clock.advance(1000);
  for (const u of [a, b]) {
    const r = await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  rid = (await view(a)).round.id;
  const s = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: ack });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return h.clock.now();
}

async function hiderUpload(hider: TestUser, t: number) {
  h.clock.set(t + 1000);
  return h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[t, 39.74, -104.99]]));
}

async function claim(seeker: TestUser) {
  const init = await h.call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
  expect(init.status, JSON.stringify(init.body)).toBe(200);
  await h.call(seeker, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
  const done = await h.call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return init.body.claimId as string;
}

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  a = await h.createUser('Avery');
  b = await h.createUser('Blake');
  const s = await h.call(a, 'POST', '/v1/sessions', {
    title: 'Edge night',
    scheduledDate: '2026-10-18',
    myTeam: 'A',
    teams: { A: { name: 'Owls', roster: [{ displayName: 'Ana' }] }, B: { name: 'Wolves', roster: [{ displayName: 'Bo' }] } },
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120, maxChaseSeconds: 600, confirmationTimeoutSeconds: 60, totalRounds: 4 },
  });
  sid = s.body.sessionId;
  const inv = await h.call(a, 'POST', `/v1/sessions/${sid}/invites`, {});
  await h.call(b, 'POST', '/v1/invites/redeem', { code: inv.body.code });
  for (const u of [a, b]) await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('edge cases', () => {
  it('round 1: claim expires via worker, pauses need both sides, time cap is censored, dispute is joint', async () => {
    const T0 = await readyStart();
    await hiderUpload(a, T0 + 2 * MIN - 5000);
    h.clock.set(T0 + 2 * MIN);
    await h.tick(sid, rid);
    expect((await view(b)).round.state).toBe('CHASE');

    // Claim at chase+1:00; hider never answers → worker expiry after 60 s.
    h.clock.set(T0 + 3 * MIN);
    const c1 = await claim(b);
    expect(h.scheduler.tasks.some((t) => t.roundId === rid && t.eventKey === 'claim_expiry')).toBe(true);
    h.clock.set(T0 + 4 * MIN + 1000);
    await h.tick(sid, rid);
    let v = await view(b);
    expect(v.round.state).toBe('CHASE');
    expect(v.round.lastClaimOutcome.status).toBe('EXPIRED');
    // Late decision after expiry is refused.
    const late = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c1}/decision`, { decision: 'CONFIRM' });
    expect(late.status).toBe(409);

    // Manual pause: Blake proposes, Avery confirms; resume needs both votes.
    h.clock.set(T0 + 5 * MIN);
    const p1 = await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'MANUAL', reason: 'traffic light' });
    expect(p1.body.pendingRequest).toBe(true);
    expect((await view(a)).round.pendingPauseRequest.byTeam).toBe('B');
    await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'MANUAL' });
    v = await view(a);
    expect(v.round.state).toBe('PAUSED');
    expect(v.round.nextPingAt).toBeNull();
    h.clock.set(T0 + 6 * MIN);
    await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/resume`, {});
    expect((await view(a)).round.state).toBe('PAUSED');
    h.clock.set(T0 + 7 * MIN);
    await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/resume`, {});
    v = await view(a);
    expect(v.round.state).toBe('CHASE');
    // Cap 10 min chase + 1 min claim window + 2 min pause → cap reached at T0 + 2 + 10 + 1 + 2 = 15 min.
    expect(Date.parse(v.round.timeCapAt)).toBe(T0 + 15 * MIN);

    h.clock.set(T0 + 16 * MIN);
    await h.tick(sid, rid);
    v = await view(a);
    expect(v.round.state).toBe('TIMED_OUT');
    expect(v.round.result).toMatchObject({ outcome: 'TIMED_OUT', isRightCensored: true, observedChaseSeconds: 600 });

    // Joint dispute: both crews accept the expired claim as the catch.
    const d1 = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c1}/dispute`, { resolution: 'ACCEPT_AS_CATCH' });
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
    expect(d1.body.resolved).toBe(false);
    const d2 = await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c1}/dispute`, { resolution: 'ACCEPT_AS_CATCH' });
    expect(d2.status, JSON.stringify(d2.body)).toBe(200);
    expect(d2.body.resolved).toBe(true);
    v = await view(b);
    expect(v.previousRounds[0]).toMatchObject({ outcome: 'CAUGHT', observedChaseSeconds: 60, isRightCensored: false });
    const sum = await h.call(b, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    expect(sum.body.result.resolvedByDispute).toBe(true);
  });

  it('host role override is recorded; rule changes mark the night not directly comparable', async () => {
    // Suggested: B hides round 2. Host overrides so A hides again.
    const next = await h.call(a, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'A', overrideReason: 'Wolves car parked far away' });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.round.hidingTeam).toBe('A');
    expect(next.body.round.roleOverride).toEqual({ reason: 'Wolves car parked far away', suggestedHidingTeam: 'B' });
    // A stale worker wake-up for round 1 (its claim window) must not re-render the
    // phones' stored views with the finished round (they would flash its recap).
    const round1 = rid;
    h.clock.advance(2 * MIN);
    expect((await h.tick(sid, round1)).status).toBe(200);
    for (const u of [a, b]) {
      const stored = (await h.deps.db.collection('sessions').doc(sid).collection('views').doc(u.uid).get()).data()!;
      expect(stored.round.id).toBe(next.body.round.id);
      expect(stored.round.state).toBe('READY');
    }
    // Host edits the ping interval before starting → readiness resets, new fingerprint.
    const edit = await h.call(a, 'PATCH', `/v1/sessions/${sid}/setup`, { rules: { pingIntervalSeconds: 180 } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await view(a)).round.ready).toEqual({ A: false, B: false });
    const T0 = await readyStart(true);
    expect((await view(a)).round.rules.pingIntervalSeconds).toBe(180);
    // Setup is frozen during a round.
    expect((await h.call(a, 'PATCH', `/v1/sessions/${sid}/setup`, { title: 'nope' })).body.error.code).toBe('GAME_CLOSED');

    // Safety pause by the seeker is immediate; then the hider withdraws consent → round aborted, tracking must stop.
    h.clock.set(T0 + 30_000);
    await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'SAFETY', reason: 'flat tire' });
    expect((await view(a)).round.pause).toMatchObject({ kind: 'SAFETY', byTeam: 'B', reason: 'flat tire' });
    const rev = await h.call(a, 'POST', `/v1/sessions/${sid}/consent`, { ...consentBody, accepted: false });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const v = await view(b);
    expect(v.round.state).toBe('ABORTED');
    expect(v.round.result.outcome).toBe('ABORTED');
    // Without consent the operator cannot ready up again.
    const ready = await h.call(a, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(ready.body.error.code).toBe('CONSENT_REQUIRED');

    const an = await h.call(a, 'GET', `/v1/sessions/${sid}/analytics`);
    expect(an.body.scorecard.comparison.status).toBe('INSUFFICIENT'); // B never hid
    expect(an.body.roleOverrides).toHaveLength(1);
  });

  it('start is blocked when a phone has location permission off, and warns on stale GPS', async () => {
    await h.call(a, 'POST', `/v1/sessions/${sid}/consent`, consentBody);
    const next = await h.call(a, 'POST', `/v1/sessions/${sid}/next-round`, {});
    rid = next.body.round.id;
    await h.call(a, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight({ permission: 'DENIED' }) });
    await h.call(b, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight({ lastFixAgeSeconds: 600, preciseLocation: false }) });
    const blocked = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
    expect(blocked.body.error.code).toBe('PERMISSION_REQUIRED');
    expect(blocked.body.error.details.blocking.some((x: string) => x.endsWith('LOCATION_PERMISSION_DENIED'))).toBe(true);
    await h.call(a, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    const warn = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false });
    expect(warn.body.error.code).toBe('GPS_UNAVAILABLE');
    expect(warn.body.error.details.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/GPS_STALE$/), expect.stringMatching(/PRECISE_LOCATION_OFF$/)]));
    const ok = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
    expect(ok.status).toBe(200);
  });
});
