import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * Edge cases over the real API + emulators: time cap (censored), claim expiry via the
 * worker, joint post-game dispute resolution, manual/safety pauses with both-side
 * resume, any crew hiding next, consent withdrawal (dropping one phone vs aborting),
 * rule changes, the night code's crew cap and regeneration, and phones moved or
 * removed between rounds.
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
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120, maxChaseSeconds: 600, confirmationTimeoutSeconds: 60 },
  });
  sid = s.body.sessionId;
  const inv = await h.call(a, 'POST', `/v1/sessions/${sid}/invites`, {});
  await h.call(b, 'POST', '/v1/invites/redeem', { code: inv.body.code, teamKey: 'B' });
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

  it('any crew may hide next; rule edits reset readiness; consent withdrawal by a lone phone aborts', async () => {
    // Suggested: B hides round 2. A hides again instead — no override bookkeeping, nights evolve.
    expect((await view(b)).nextRound).toEqual({ index: 2, suggestedHidingTeam: 'B' });
    const next = await h.call(b, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'A' });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.round.hidingTeam).toBe('A');
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
    // Either crew edits the ping interval before starting → readiness resets, new fingerprint.
    expect((await h.call(a, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
    expect((await view(a)).round.ready).toEqual({ A: true, B: false });
    const edit = await h.call(b, 'PATCH', `/v1/sessions/${sid}/setup`, { rules: { pingIntervalSeconds: 180 } });
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
    expect(an.body).not.toHaveProperty('roleOverrides');
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

describe('compressed uploads', () => {
  it('accepts a gzip-compressed location batch and refuses one that inflates past the body limit', async () => {
    const { gzipSync } = await import('node:zlib');
    const v = await view(a);
    const r = v.round;
    expect(r.state).toBe('HEAD_START');
    h.clock.advance(130_000); // every sample below falls inside the round
    const body = batch(h.clock, Array.from({ length: 120 }, (_, i) => [h.clock.now() - (120 - i) * 1000, 39.74 + i * 1e-5, -104.99] as [number, number, number]));
    const gz = gzipSync(Buffer.from(JSON.stringify(body)));
    const ok = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${r.id}/location-batches`, gz, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.accepted).toBe(120);
    const bomb = gzipSync(Buffer.alloc(2_000_000, 0x20));
    const big = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${r.id}/location-batches`, bomb, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(big.status).toBe(413);
    const junk = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${r.id}/location-batches`, Buffer.from([0x1f, 0x8b, 1, 2, 3]), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(junk.status).toBe(400);
  });
});

describe('crews, night code and phones', () => {
  let org: TestUser;
  let night: string;
  let nightCode: string;
  const phones: TestUser[] = [];

  beforeAll(async () => {
    org = await h.createUser('Organizer');
    const s = await h.call(org, 'POST', '/v1/sessions', {
      title: 'Crew night',
      scheduledDate: '2026-10-19',
      myTeam: 'A',
      teams: { A: { name: 'Owls', roster: [] }, B: { name: 'Wolves', roster: [] }, C: { name: 'Foxes', roster: [] } },
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    night = s.body.sessionId;
    nightCode = s.body.session.joinCode;
    expect(Object.keys(s.body.session.teams)).toEqual(['A', 'B', 'C']);
    for (let i = 0; i < 5; i++) phones.push(await h.createUser(`Phone${i}`));
  }, 60_000);

  const nv = async (u: TestUser) => (await h.call(u, 'GET', `/v1/sessions/${night}`)).body;

  it('a crew takes at most five phones', async () => {
    for (const p of phones.slice(0, 4)) {
      const r = await h.call(p, 'POST', '/v1/invites/redeem', { code: nightCode, teamKey: 'A' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const full = await h.call(phones[4]!, 'POST', '/v1/invites/redeem', { code: nightCode, teamKey: 'A' });
    expect(full.status).toBe(409);
    const prev = await h.call(phones[4]!, 'POST', '/v1/invites/preview', { code: nightCode });
    expect(prev.body.teams.A).toMatchObject({ phoneCount: 5, full: true });
    expect(prev.body.suggestedTeam).toBe('B');
    // Without a crew choice the phone joins the crew with the fewest phones.
    const ok = await h.call(phones[4]!, 'POST', '/v1/invites/redeem', { code: nightCode });
    expect(ok.body.session.myTeam).toBe('B');
  });

  it('phones move between crews and can be removed; a removed phone loses the live view', async () => {
    const move = await h.call(phones[0]!, 'PATCH', `/v1/sessions/${night}/setup`, {
      moves: [
        { uid: phones[1]!.uid, teamKey: 'C' },
        { uid: phones[2]!.uid, teamKey: null },
      ],
    });
    expect(move.status, JSON.stringify(move.body)).toBe(200);
    const v = await nv(org);
    expect(v.session.teams.A.operators).toHaveLength(3);
    expect(v.session.teams.C.operators.map((o: any) => o.displayName)).toEqual(['Phone1']);
    expect((await nv(phones[1]!)).session.myTeam).toBe('C');
    expect((await h.call(phones[2]!, 'GET', `/v1/sessions/${night}`)).status).toBe(404);
    // The organizer's phone cannot be removed by someone else.
    const rm = await h.call(phones[0]!, 'PATCH', `/v1/sessions/${night}/setup`, { moves: [{ uid: org.uid, teamKey: null }] });
    expect(rm.body.error.code).toBe('FORBIDDEN');
    // A removed phone can rejoin with the code.
    expect((await h.call(phones[2]!, 'POST', '/v1/invites/redeem', { code: nightCode, teamKey: 'C' })).status).toBe(200);
  });

  it('removing a crew moves its phones to the emptiest remaining crew; a night keeps at least two crews', async () => {
    const r = await h.call(org, 'PATCH', `/v1/sessions/${night}/setup`, { teams: { C: null } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = await nv(org);
    expect(Object.keys(v.session.teams)).toEqual(['A', 'B']);
    expect(v.round.seekingTeams).toEqual(['B']);
    expect(v.session.teams.B.operators.length).toBe(3);
    const two = await h.call(org, 'PATCH', `/v1/sessions/${night}/setup`, { teams: { B: null } });
    expect(two.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('operator lists cannot be smuggled through crew edits', async () => {
    const r = await h.call(org, 'PATCH', `/v1/sessions/${night}/setup`, { teams: { A: { name: 'Owls', operatorUids: [phones[4]!.uid] } } });
    expect(r.status).toBe(400);
  });

  it('regenerating the code revokes the old one', async () => {
    const regen = await h.call(phones[3]!, 'POST', `/v1/sessions/${night}/invites`, { regenerate: true });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(regen.body.code).not.toBe(nightCode);
    const outsider = await h.createUser('Outsider2');
    expect((await h.call(outsider, 'POST', '/v1/invites/redeem', { code: nightCode })).status).toBe(410);
    expect((await h.call(outsider, 'POST', '/v1/invites/redeem', { code: regen.body.code })).status).toBe(200);
    expect((await nv(org)).session.joinCode).toBe(regen.body.code);
  });

  it('consent withdrawn by one of two hider phones drops it; the round carries on', async () => {
    const crewA = [org, phones[0]!];
    for (const u of [...crewA, phones[4]!]) expect((await h.call(u, 'POST', `/v1/sessions/${night}/consent`, consentBody)).status).toBe(200);
    for (const u of [org, phones[4]!]) await h.call(u, 'POST', `/v1/sessions/${night}/ready`, { ready: true, preflight: healthyPreflight() });
    const v = await nv(org);
    const start = await h.call(phones[4]!, 'POST', `/v1/sessions/${night}/rounds/${v.round.id}/start`, { acknowledgeWarnings: true });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    // Phones without consent are not part of the round (spectators).
    const spectator = await nv(phones[3]!);
    expect(spectator.round.myRole).toBeNull();
    h.clock.advance(MIN);
    expect((await h.call(phones[0]!, 'POST', `/v1/sessions/${night}/consent`, { ...consentBody, accepted: false })).status).toBe(200);
    const after = await nv(org);
    expect(after.round.state).toBe('HEAD_START');
    expect(after.round.crewStatus.A.total).toBe(1);
    // A spectator can't upload, claim or pause.
    const up = await h.call(phones[3]!, 'POST', `/v1/sessions/${night}/rounds/${v.round.id}/location-batches`, batch(h.clock, [[h.clock.now(), 39.7, -104.9]]));
    expect(up.status).toBe(403);
    expect((await h.call(phones[3]!, 'POST', `/v1/sessions/${night}/rounds/${v.round.id}/pause`, { kind: 'SAFETY' })).status).toBe(403);
    // The last hider phone leaving aborts.
    expect((await h.call(org, 'POST', `/v1/sessions/${night}/consent`, { ...consentBody, accepted: false })).status).toBe(200);
    expect((await nv(phones[4]!)).round.state).toBe('ABORTED');
  });
});
