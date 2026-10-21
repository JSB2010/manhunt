import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * End-to-end open night against the Firebase emulators (real Auth tokens, real
 * Firestore transactions and rules, real Storage), with a controllable server
 * clock: two crews grow to three, one crew carries two equal phones, a RACE
 * round, a hider outage across a ping deadline, crews edited between rounds,
 * and a night ended by any phone. Mirrors spec §3.1/§3.4 and §6.4, ADRs 0013–0015.
 */
let h: Harness;
let morgan: TestUser; // organizer, Crew A
let drew: TestUser; // second phone on Crew A
let taylor: TestUser; // Crew B
let alex: TestUser; // Crew C (added between rounds)
let sid: string;
let rid: string;
let code: string;
let T0: number;

const START = { lat: 39.7392, lon: -104.9903 };
// Hiders walk ~1.4 m/s east; seekers drive ~12 m/s north (only during chase).
const hiderAt = (t: number) => ({ lat: START.lat, lon: START.lon + ((t - T0) / 1000) * (1.4 / 85_300) });
const seekerAt = (t: number, chaseStart: number) => ({ lat: START.lat - 0.02 + Math.max(0, (t - chaseStart) / 1000) * (12 / 111_000), lon: START.lon - 0.01 });

/**
 * Every phone records every 10 s and uploads every 20 s. Hider phone i records
 * i×3 s after phone 0, so the freshest fix at a deadline comes from the last phone.
 */
async function track(hiders: TestUser[], seekers: TestUser[], from: number, to: number, chaseStart: number) {
  for (let t = from; t < to; t += 20_000) {
    h.clock.set(t + 20_000);
    for (const [i, u] of hiders.entries()) {
      const pts: [number, number, number][] = [];
      for (let s = t + i * 3000; s < t + 20_000; s += 10_000) pts.push([s, hiderAt(s).lat, hiderAt(s).lon]);
      const r = await h.call(u, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, pts));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    for (const u of seekers) {
      const pts: [number, number, number][] = [];
      for (let s = t; s < t + 20_000; s += 10_000) pts.push([s, seekerAt(s, chaseStart).lat, seekerAt(s, chaseStart).lon]);
      const r = await h.call(u, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, pts));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  }
}

async function view(u: TestUser) {
  const r = await h.call(u, 'GET', `/v1/sessions/${sid}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function firestoreView(u: TestUser) {
  return (await h.deps.db.collection('sessions').doc(sid).collection('views').doc(u.uid).get()).data() as any;
}

/** One phone per crew taps Ready; `starter` (any operator) starts. */
async function readyAndStart(readyPhones: TestUser[], starter: TestUser) {
  h.clock.advance(1000);
  for (const u of readyPhones) {
    const r = await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const v = await view(starter);
  rid = v.round.id;
  const s = await h.call(starter, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return h.clock.now();
}

async function capture(seeker: TestUser) {
  const init = await h.call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
  expect(init.status, JSON.stringify(init.body)).toBe(200);
  const up = await h.call(seeker, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
  expect(up.status, JSON.stringify(up.body)).toBe(200);
  const done = await h.call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId }, { 'idempotency-key': `cap-${init.body.claimId}` });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return init.body.claimId as string;
}

const decide = (u: TestUser, claimId: string, decision: 'CONFIRM' | 'REJECT', reason?: string) =>
  h.call(u, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${claimId}/decision`, { decision, ...(reason ? { reason } : {}) });

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  morgan = await h.createUser('Morgan');
  drew = await h.createUser('Drew');
  taylor = await h.createUser('Taylor');
  alex = await h.createUser('Alex');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('open night with crews of several phones', () => {
  it('organizer creates a two-crew night with guest names; it comes with a night code', async () => {
    const me = await h.call(morgan, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    const selfPerson = me.body.profile.selfPersonId;
    const r = await h.call(morgan, 'POST', '/v1/sessions', {
      title: 'Friday Manhunt',
      scheduledDate: '2026-10-17',
      myTeam: 'A',
      teams: {
        A: { name: 'Crew A', roster: [{ personId: selfPerson, displayName: 'Morgan' }, { displayName: 'Casey' }, { displayName: 'Jules' }] },
        B: { name: 'Crew B', roster: [{ displayName: 'Riley' }, { displayName: 'Sam' }] },
      },
      rules: { headStartSeconds: 600, pingIntervalSeconds: 600, visiblePingHistoryCount: 1 },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    sid = r.body.sessionId;
    expect(r.body.session.status).toBe('LOBBY');
    expect(r.body.session.teams.A.roster.map((p: any) => p.displayName)).toEqual(['Morgan', 'Casey', 'Jules']);
    expect(r.body.session.teams.A.operators).toEqual([expect.objectContaining({ displayName: 'Morgan', isMe: true })]);
    expect(r.body.session.joinCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.body.round).toMatchObject({ state: 'READY', hidingTeam: 'A', seekingTeams: ['B'], seekMode: 'TOGETHER' });
    expect(r.body.session).not.toHaveProperty('totalRounds');
  });

  it('phones join with the reusable night code and pick a crew; re-joining is a no-op', async () => {
    const inv = await h.call(morgan, 'POST', `/v1/sessions/${sid}/invites`, {});
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    code = inv.body.code;
    // Fetching it again returns the same code (no new invite per sheet open).
    expect((await h.call(morgan, 'POST', `/v1/sessions/${sid}/invites`, {})).body.code).toBe(code);
    const prev = await h.call(taylor, 'POST', '/v1/invites/preview', { code });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(prev.body.suggestedTeam).toBe('B');
    expect(prev.body.teams.A).toMatchObject({ phoneCount: 1, full: false });
    const red = await h.call(taylor, 'POST', '/v1/invites/redeem', { code, teamKey: 'B' });
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    expect(red.body.session.myTeam).toBe('B');
    // Taylor's own person record was added to Crew B's roster.
    expect(red.body.session.teams.B.roster.map((p: any) => p.displayName)).toContain('Taylor');
    // A second phone on Crew A — equal to the first.
    const d = await h.call(drew, 'POST', '/v1/invites/redeem', { code, teamKey: 'A' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.session.teams.A.operators.map((o: any) => o.displayName)).toEqual(['Morgan', 'Drew']);
    const again = await h.call(taylor, 'POST', '/v1/invites/redeem', { code, teamKey: 'A' });
    expect(again.status).toBe(200);
    expect(again.body.session.myTeam).toBe('B');
    expect(h.notifier.sent.some((n) => n.kind === 'OPERATOR_JOINED' && n.toUids.includes(morgan.uid))).toBe(true);
  });

  it('ready requires consent; start requires every crew ready', async () => {
    const noConsent = await h.call(taylor, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    for (const u of [morgan, drew, taylor]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    const v = await view(morgan);
    rid = v.round.id;
    expect((await h.call(drew, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
    const early = await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
    expect(early.body.error.code).toBe('GAME_NOT_READY');
    // Drew's mark counts for the whole crew.
    expect((await view(morgan)).round.ready).toEqual({ A: true, B: false });
  });

  it('round 1: pings come from the freshest hider phone; any hider phone decides, the second decision loses', async () => {
    // Morgan's phone reports its location health too; the seeking crew starts: there is no lead phone.
    T0 = await readyAndStart([morgan, taylor], taylor);
    const hv = await view(drew);
    expect(hv.round).toMatchObject({ state: 'HEAD_START', myRole: 'HIDING', myTeam: 'A' });
    expect(Date.parse(hv.round.headStartEndsAt)).toBe(T0 + 10 * MIN);
    expect(h.scheduler.tasks.some((t) => t.roundId === rid && t.eventKey === 'chase_start' && t.at === T0 + 10 * MIN)).toBe(true);

    const chaseStart = T0 + 10 * MIN;
    await track([morgan, drew], [taylor], T0, chaseStart, chaseStart);
    h.clock.set(chaseStart);
    expect((await h.tick(sid, rid)).status).toBe(200);
    let sv = await view(taylor);
    expect(sv.round.state).toBe('CHASE');
    expect(sv.round.pins).toHaveLength(1);
    expect(Date.parse(sv.round.pins[0].scheduledAt)).toBe(chaseStart);
    // Drew records 3 s after Morgan: the freshest fix at 8:10 is Drew's 8:09:53.
    expect(Date.parse(sv.round.pins[0].observedAt)).toBe(chaseStart - 7000);
    expect(sv.round.crewStatus.A).toMatchObject({ live: 2, total: 2 });
    expect(JSON.stringify(sv.round)).not.toContain(drew.uid);
    const fsv = await firestoreView(taylor);
    expect(fsv.round.pins).toHaveLength(1);

    await track([morgan, drew], [taylor], chaseStart, T0 + 36 * MIN, chaseStart);
    h.clock.set(T0 + 36 * MIN);
    await h.tick(sid, rid);
    sv = await view(taylor);
    expect(sv.round.pingLog.map((p: any) => p.index)).toEqual([0, 1, 2]);
    expect(sv.round.pins.map((p: any) => p.index)).toEqual([2]); // history count = 1

    const claimId = await capture(taylor);
    sv = await view(taylor);
    expect(sv.round.state).toBe('CAPTURE_PENDING');
    expect(sv.round.myClaim).toMatchObject({ status: 'PENDING', byMe: true });
    expect(sv.round.chaseClock).toEqual({ accumulatedMs: 26 * MIN, runningSince: null });
    for (const u of [morgan, drew]) expect((await view(u)).round.captureRequest.claimId).toBe(claimId);
    expect(h.notifier.sent.some((n) => n.kind === 'CLAIM_SUBMITTED' && n.toUids.includes(morgan.uid) && n.toUids.includes(drew.uid))).toBe(true);

    // Either hider phone can review the photo: EXIF/GPS metadata stripped.
    const photo = await h.call(drew, 'GET', (await view(drew)).round.captureRequest.photoPath);
    expect(photo.status).toBe(200);
    expect(photo.raw.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(photo.raw.includes(Buffer.from('device-serial'))).toBe(false);

    h.clock.set(T0 + 38 * MIN);
    const [a, b] = await Promise.all([decide(drew, claimId, 'CONFIRM'), decide(morgan, claimId, 'REJECT', 'not us')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.message).toMatch(/already decided/);
    const r = (await view(taylor)).round;
    expect(r.state).toBe(a.status === 200 ? 'COMPLETED' : 'CHASE');
    if (r.state === 'CHASE') {
      // Morgan's rejection landed first: the seeker keeps driving, then a fresh claim is confirmed.
      await track([morgan, drew], [taylor], h.clock.now(), h.clock.now() + 20_000, T0 + 10 * MIN);
      const c2 = await capture(taylor);
      h.clock.advance(30_000);
      expect((await decide(morgan, c2, 'CONFIRM')).status).toBe(200);
    }
    expect((await view(taylor)).round.result.outcome).toBe('CAUGHT');
  });

  it('recap: per-crew distances from the best-covered phone, routes for every crew, no winner', async () => {
    const sum = await h.call(taylor, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    const r = sum.body.result;
    expect(r.outcome).toBe('CAUGHT');
    expect(r.catchCreditTeams).toEqual(['B']);
    expect(r.crews.A).toMatchObject({ role: 'HIDING', phones: 2, routeQuality: 'GOOD' });
    expect(r.crews.A.distanceTotalMeters).toBeGreaterThan(r.crews.A.distanceChaseMeters);
    expect(r.crews.A.distanceTotalMeters).toBeGreaterThan(2500);
    expect(r.crews.A.distanceTotalMeters).toBeLessThan(3600);
    expect(r.crews.B.distanceChaseMeters).toBeGreaterThan(17_000);
    expect(r.crews.A.gpsCoverageFraction).toBeGreaterThan(0.9);
    expect(sum.body.pings.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(sum.body)).not.toMatch(/sourceUid|routeSourceUids|"winner"/i);
    const routes = await h.call(taylor, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(routes.status, JSON.stringify(routes.body)).toBe(200);
    expect(routes.body.teams.A.role).toBe('HIDING');
    expect(routes.body.teams.A.segments[0].points.length).toBeGreaterThan(1);
    expect(routes.body.teams.B.segments[0].points.length).toBeGreaterThan(1);
    expect(routes.body.markers.claimPoint).not.toBeNull();
    const v = await view(drew);
    expect(v.session.status).toBe('BETWEEN_ROUNDS');
    expect(v.nextRound).toEqual({ index: 2, suggestedHidingTeam: 'B' });
  });

  it('between rounds: add a third crew, a phone joins it, and a READY round is re-targeted', async () => {
    const add = await h.call(drew, 'PATCH', `/v1/sessions/${sid}/setup`, { teams: { C: { name: 'Crew C', roster: [{ displayName: 'Quinn' }] } } });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const j = await h.call(alex, 'POST', '/v1/invites/redeem', { code, teamKey: 'C' });
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    expect((await h.call(alex, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    const next = await h.call(taylor, 'POST', `/v1/sessions/${sid}/next-round`, {});
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.round).toMatchObject({ index: 2, state: 'READY', hidingTeam: 'B', seekingTeams: ['A', 'C'] });
    // Any crew may hide next, in RACE mode.
    const re = await h.call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'C', seekMode: 'RACE' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.round).toMatchObject({ index: 2, hidingTeam: 'C', seekingTeams: ['A', 'B'], seekMode: 'RACE' });
    expect((await view(alex)).round.id).toBe(re.body.round.id);
  });

  it('round 2 (RACE): the hider goes offline across a ping; it waits, then releases the current position on reconnect', async () => {
    T0 = await readyAndStart([alex, morgan, taylor], alex);
    const chaseStart = T0 + 10 * MIN;
    await track([alex], [morgan, taylor], T0, T0 + 8 * MIN, chaseStart);
    // Alex loses signal at 8:08 and records offline until 8:13.
    await track([], [morgan, taylor], T0 + 8 * MIN, chaseStart, chaseStart);
    h.clock.set(chaseStart);
    await h.tick(sid, rid);
    let sv = await view(taylor);
    expect(sv.round.pins).toEqual([]);
    expect(sv.round.waitingPing).toMatchObject({ index: 0, deadline: new Date(chaseStart).toISOString() });
    expect(h.notifier.sent.some((n) => n.kind === 'PING_WAITING' && n.toUids.includes(alex.uid))).toBe(true);
    // Still waiting a minute later (watchdog/tick backstop does nothing without a fix).
    h.clock.set(chaseStart + MIN);
    await h.tick(sid, rid);
    expect((await view(morgan)).round.waitingPing).not.toBeNull();

    // Reconnect at 8:13: the queued backlog uploads in one batch. Only the current fix is released.
    h.clock.set(T0 + 13 * MIN);
    const backlog: [number, number, number][] = [];
    for (let s = T0 + 8 * MIN; s < T0 + 13 * MIN; s += 10_000) backlog.push([s, hiderAt(s).lat, hiderAt(s).lon]);
    const up = await h.call(alex, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, backlog));
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    sv = await view(taylor);
    expect(sv.round.waitingPing).toBeNull();
    expect(sv.round.pins).toHaveLength(1);
    const pin = sv.round.pins[0];
    expect(pin).toMatchObject({ index: 0, delayed: true });
    const newest = T0 + 13 * MIN - 10_000;
    expect(Date.parse(pin.observedAt)).toBe(newest);
    expect([pin.latitude, pin.longitude]).toEqual([hiderAt(newest).lat, hiderAt(newest).lon]);
    expect(h.notifier.sent.some((n) => n.kind === 'PING_LATE' && n.toUids.includes(taylor.uid))).toBe(true);
    // The next ping is still on the original schedule.
    expect(Date.parse(sv.round.nextPingAt)).toBe(chaseStart + 10 * MIN);

    await track([alex], [morgan, taylor], T0 + 13 * MIN, T0 + 30 * MIN, chaseStart);
    h.clock.set(T0 + 30 * MIN);
    await h.tick(sid, rid);
    const claimId = await capture(taylor);
    // RACE: the other seeking crew learns who claimed, but not the claim or its photo.
    const mv = await view(morgan);
    expect(mv.round.claimByTeam).toBe('B');
    expect(mv.round.myClaim).toBeNull();
    expect((await h.call(morgan, 'GET', `/v1/sessions/${sid}/rounds/${rid}/captures/${claimId}/photo`)).status).toBe(404);
    h.clock.advance(30_000);
    expect((await decide(alex, claimId, 'CONFIRM')).status).toBe(200);
    const done = (await view(morgan)).round;
    expect(done.result.catchCreditTeams).toEqual(['B']);
    expect(Object.keys(done.result.crews).sort()).toEqual(['A', 'B', 'C']);
  });

  it('round 3: a phone moves crews between rounds, any phone ends the night, the code stops working', async () => {
    const mv = await h.call(alex, 'PATCH', `/v1/sessions/${sid}/setup`, { moves: [{ uid: drew.uid, teamKey: 'B' }] });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    expect((await view(drew)).session.myTeam).toBe('B');
    const next = await h.call(drew, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'B', seekMode: 'TOGETHER' });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    T0 = await readyAndStart([drew, morgan, alex], morgan);
    expect((await view(drew)).round).toMatchObject({ myRole: 'HIDING', hidingTeam: 'B' });

    // Bandwidth: a health-only upload changes nothing other phones see, so their views are not rewritten,
    // and a conditional GET of an unchanged view is a body-less 304.
    const ref = h.deps.db.doc(`sessions/${sid}/views/${taylor.uid}`);
    const before = (await ref.get()).updateTime!;
    h.clock.advance(5000);
    const hb = await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[h.clock.now() - 1000, START.lat - 0.02, START.lon - 0.01]]));
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect((await ref.get()).updateTime!.isEqual(before)).toBe(true);
    const full = await h.call(taylor, 'GET', `/v1/sessions/${sid}`);
    expect(full.headers.etag).toBe(`"${full.body.viewHash}"`);
    const cond = await h.call(taylor, 'GET', `/v1/sessions/${sid}`, undefined, { 'if-none-match': full.headers.etag as string });
    expect(cond.status).toBe(304);
    expect(cond.raw.length).toBe(0);
    const chaseStart = T0 + 10 * MIN;
    await track([taylor, drew], [morgan, alex], T0, chaseStart + 9 * MIN, chaseStart);
    h.clock.set(chaseStart + 9 * MIN);
    await h.tick(sid, rid);
    const c = await capture(alex);
    h.clock.advance(20_000);
    expect((await decide(taylor, c, 'CONFIRM')).status).toBe(200);
    expect((await view(alex)).round.result.catchCreditTeams).toEqual(['A', 'C']);

    // No round count: the night stays open until someone ends it.
    expect((await view(alex)).nextRound).toEqual({ index: 4, suggestedHidingTeam: 'A' });
    const end = await h.call(alex, 'POST', `/v1/sessions/${sid}/complete`, {});
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    const v = await view(taylor);
    expect(v.session.status).toBe('COMPLETED');
    expect(v.session.joinCode).toBeNull();
    expect(v.nextRound).toBeNull();
    expect(v.previousRounds.map((b: any) => b.hidingTeam)).toEqual(['A', 'C', 'B']);
    const late = await h.createUser('Late');
    expect((await h.call(late, 'POST', '/v1/invites/redeem', { code })).status).toBe(410);
    expect((await h.call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, {})).body.error.code).toBe('GAME_CLOSED');
  });

  it('scorecard covers three crews; changed seek setups make the comparison provisional', async () => {
    const an = await h.call(taylor, 'GET', `/v1/sessions/${sid}/analytics`);
    expect(an.status).toBe(200);
    const sc = an.body.scorecard;
    expect(Object.keys(sc.teams).sort()).toEqual(['A', 'B', 'C']);
    for (const k of ['A', 'B', 'C']) expect(sc.teams[k].hideRoundCount).toBe(1);
    expect(sc.teams.B.seekCreditedCatches).toBe(2);
    expect(sc.teams.A.seekCaughtByOtherCrew).toBe(1);
    // Round 1 had one seeking crew, rounds 2–3 had two (RACE, then TOGETHER).
    expect(sc.comparison.status).toBe('PROVISIONAL');
    expect(sc.comparison.reasons).toContain('RULES_DIFFER');
    expect(sc.comparison.strongerHidingTeam).toBeNull();
    expect(JSON.stringify(an.body)).not.toMatch(/"winner"/i);
  });

  it('exports CSV/JSON without GPS and person analytics are crew-attributed', async () => {
    const csv = await h.call(morgan, 'GET', `/v1/export/sessions/${sid}.csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.split('\n')[0]).toContain('seeking_crews');
    expect(csv.body.split('\n')).toHaveLength(5); // header + 3 rounds + trailing newline
    expect(csv.body).not.toMatch(/39\.73|104\.99/);
    const json = await h.call(morgan, 'GET', `/v1/export/sessions/${sid}.json`);
    expect(JSON.stringify(json.body)).not.toMatch(/latitude|longitude/);
    const people = await h.call(morgan, 'GET', '/v1/people?q=casey');
    const casey = people.body.people[0];
    expect(casey.displayName).toBe('Casey');
    const stats = await h.call(morgan, 'GET', `/v1/analytics/people/${casey.id}`);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.analytics.attribution).toBe('CREW_LEVEL');
    expect(stats.body.analytics.roundsCrewHid).toBe(1);
    expect(stats.body.analytics.roundsCrewSought).toBe(2);
    expect(stats.body.analytics.pairedNights.provisional).toBe(1);
    const viaNight = await h.call(taylor, 'GET', `/v1/analytics/people/${casey.id}`);
    expect(viaNight.status, JSON.stringify(viaNight.body)).toBe(200);
    const outsider = await h.createUser('Outsider');
    expect((await h.call(outsider, 'GET', `/v1/analytics/people/${casey.id}`)).status).toBe(404);
    const list = await h.call(alex, 'GET', '/v1/sessions?q=quinn');
    expect(list.body.items.map((s: any) => s.id)).toContain(sid);
  });
});
