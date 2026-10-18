import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * End-to-end two-operator night against the Firebase emulators (real Auth
 * tokens, real Firestore transactions and rules, real Storage), with a
 * controllable server clock. Mirrors spec §3.1/§3.4 and §6.4.
 */
let h: Harness;
let morgan: TestUser; // host, Crew A operator
let taylor: TestUser; // Crew B operator
let sid: string;
let rid: string;
let T0: number;

const START = { lat: 39.7392, lon: -104.9903 };
// Hider walks ~1.4 m/s east; seeker drives ~12 m/s north (only during chase).
const hiderAt = (t: number) => ({ lat: START.lat, lon: START.lon + ((t - T0) / 1000) * (1.4 / 85_300) });
const seekerAt = (t: number, chaseStart: number) => ({ lat: START.lat - 0.02 + Math.max(0, (t - chaseStart) / 1000) * (12 / 111_000), lon: START.lon - 0.01 });

async function track(hider: TestUser, seeker: TestUser, from: number, to: number, chaseStart: number, opts: { hiderOffline?: [number, number] } = {}) {
  // Each operator records every 10 s and uploads every 20 s.
  for (let t = from; t < to; t += 20_000) {
    h.clock.set(t + 20_000);
    const hp: [number, number, number][] = [];
    const sp: [number, number, number][] = [];
    for (let s = t; s < t + 20_000; s += 10_000) {
      const offline = opts.hiderOffline && s >= opts.hiderOffline[0] && s < opts.hiderOffline[1];
      if (!offline) hp.push([s, hiderAt(s).lat, hiderAt(s).lon]);
      sp.push([s, seekerAt(s, chaseStart).lat, seekerAt(s, chaseStart).lon]);
    }
    if (hp.length) {
      const r = await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, hp));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const r2 = await h.call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, sp));
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
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

async function readyAndStart(host: TestUser, other: TestUser) {
  h.clock.advance(1000);
  for (const u of [host, other]) {
    const r = await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const v = await view(host);
  rid = v.round.id;
  const s = await h.call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false });
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

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  morgan = await h.createUser('Morgan');
  taylor = await h.createUser('Taylor');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('two-operator vertical slice', () => {
  it('host creates a night with named crews and guest people', async () => {
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
    expect(r.body.round.state).toBe('READY');
    expect(r.body.round.hidingTeam).toBe('A');
  });

  it('second operator joins via expiring code; a third account cannot', async () => {
    const inv = await h.call(morgan, 'POST', `/v1/sessions/${sid}/invites`, {});
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.code).toMatch(/^[A-Z2-9]{8}$/);
    const prev = await h.call(taylor, 'POST', '/v1/invites/preview', { code: inv.body.code });
    expect(prev.body.teamKey).toBe('B');
    const red = await h.call(taylor, 'POST', '/v1/invites/redeem', { code: inv.body.code });
    expect(red.status, JSON.stringify(red.body)).toBe(200);
    expect(red.body.session.myTeam).toBe('B');
    // Taylor's own person record was added to Crew B's roster.
    expect(red.body.session.teams.B.roster.map((p: any) => p.displayName)).toContain('Taylor');
    const third = await h.createUser('Mallory');
    const again = await h.call(third, 'POST', '/v1/invites/redeem', { code: inv.body.code });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('INVITE_INVALID');
  });

  it('ready requires consent; start requires both ready', async () => {
    const noConsent = await h.call(taylor, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    for (const u of [morgan, taylor]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    const v = await view(morgan);
    rid = v.round.id;
    const early = await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
    expect(early.body.error.code).toBe('GAME_NOT_READY');
  });

  it('round 1: head start, first ping exactly at chase start, scheduled pings, capture confirmed at submission time', async () => {
    T0 = await readyAndStart(morgan, taylor);
    let hv = await view(morgan);
    expect(hv.round.state).toBe('HEAD_START');
    expect(hv.round.myRole).toBe('HIDING');
    expect(Date.parse(hv.round.headStartEndsAt)).toBe(T0 + 10 * MIN);
    // Scheduler was asked to wake at chase start.
    expect(h.scheduler.tasks.some((t) => t.roundId === rid && t.eventKey === 'chase_start' && t.at === T0 + 10 * MIN)).toBe(true);

    const chaseStart = T0 + 10 * MIN;
    await track(morgan, taylor, T0, chaseStart, chaseStart);
    h.clock.set(chaseStart);
    expect((await h.tick(sid, rid)).status).toBe(200);
    let sv = await view(taylor);
    expect(sv.round.state).toBe('CHASE');
    expect(sv.round.pins).toHaveLength(1);
    expect(sv.round.pins[0].index).toBe(0);
    expect(Date.parse(sv.round.pins[0].scheduledAt)).toBe(chaseStart);
    expect(Date.parse(sv.round.pins[0].observedAt)).toBeLessThanOrEqual(chaseStart);
    expect(sv.round.pins[0].ageSeconds).toBeLessThanOrEqual(60);
    expect(Date.parse(sv.round.nextPingAt)).toBe(chaseStart + 10 * MIN);
    // Firestore view doc (what the iPhone listener receives) matches.
    const fsv = await firestoreView(taylor);
    expect(fsv.round.pins).toHaveLength(1);

    await track(morgan, taylor, chaseStart, chaseStart + 20 * MIN, chaseStart);
    h.clock.set(chaseStart + 20 * MIN);
    await h.tick(sid, rid);
    sv = await view(taylor);
    expect(sv.round.pingLog.map((p: any) => p.index)).toEqual([0, 1, 2]);
    expect(sv.round.pins.map((p: any) => p.index)).toEqual([2]); // history count = 1

    // 8:36 photo claim → 26:00 chase time even though confirmation is later.
    await track(morgan, taylor, chaseStart + 20 * MIN, T0 + 36 * MIN, chaseStart);
    h.clock.set(T0 + 36 * MIN);
    const claimId = await capture(taylor);
    sv = await view(taylor);
    expect(sv.round.state).toBe('CAPTURE_PENDING');
    expect(sv.round.myClaim.status).toBe('PENDING');
    expect(sv.round.chaseClock).toEqual({ accumulatedMs: 26 * MIN, runningSince: null });
    hv = await view(morgan);
    expect(hv.round.captureRequest.claimId).toBe(claimId);
    expect(hv.round.captureRequest.chaseSecondsAtClaim).toBe(26 * 60);
    expect(h.notifier.sent.some((n) => n.kind === 'CLAIM_SUBMITTED' && n.toUids.includes(morgan.uid))).toBe(true);

    // Hider reviews the photo: EXIF/GPS metadata stripped.
    const photo = await h.call(morgan, 'GET', hv.round.captureRequest.photoPath);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.raw.includes(Buffer.from('GPSLatitude'))).toBe(false);
    expect(photo.raw.includes(Buffer.from('device-serial'))).toBe(false);

    h.clock.set(T0 + 38 * MIN);
    const dec = await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${claimId}/decision`, { decision: 'CONFIRM' });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    expect(dec.body.result.observedChaseSeconds).toBe(26 * 60);
    expect(Date.parse(dec.body.result.officialFoundAt ? new Date(dec.body.result.officialFoundAt).toISOString() : '')).toBe(T0 + 36 * MIN);
  });

  it('recap: separate walking/driving distances, coverage, routes for both crews, no winner banner', async () => {
    const sum = await h.call(taylor, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`);
    expect(sum.status, JSON.stringify(sum.body)).toBe(200);
    const r = sum.body.result;
    expect(r.outcome).toBe('CAUGHT');
    expect(r.hidingDistanceTotalMeters).toBeGreaterThan(r.hidingDistanceChaseMeters);
    // ~36 min at 1.4 m/s ≈ 3 km walking total
    expect(r.hidingDistanceTotalMeters).toBeGreaterThan(2500);
    expect(r.hidingDistanceTotalMeters).toBeLessThan(3400);
    // seeker drove only during chase: ~26 min at 12 m/s ≈ 18.7 km
    expect(r.seekingDistanceChaseMeters).toBeGreaterThan(17_000);
    expect(r.gpsCoverageFractionHider).toBeGreaterThan(0.9);
    expect(r.routeQualityHider).toBe('GOOD');
    expect(sum.body.pings).toHaveLength(3);
    const routes = await h.call(taylor, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes`);
    expect(routes.status, JSON.stringify(routes.body)).toBe(200);
    expect(routes.body.teams.A.role).toBe('HIDING');
    expect(routes.body.teams.A.segments[0].points.length).toBeGreaterThan(1);
    expect(routes.body.teams.B.segments[0].points.length).toBeGreaterThan(1);
    expect(routes.body.markers.claimPoint).not.toBeNull();
    const geo = await h.call(morgan, 'GET', `/v1/sessions/${sid}/rounds/${rid}/routes?format=geojson`);
    expect(geo.body.type).toBe('FeatureCollection');
    const v = await view(morgan);
    expect(v.session.status).toBe('BETWEEN_ROUNDS');
    expect(v.nextRound).toEqual({ index: 2, suggestedHidingTeam: 'B' });
    expect(JSON.stringify(sum.body)).not.toMatch(/"winner"/i);
  });

  it('round 2: roles swap, rejected claim resumes clock and shifts pings, then confirmed', async () => {
    const next = await h.call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, {});
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.round.index).toBe(2);
    expect(next.body.round.hidingTeam).toBe('B');
    expect(next.body.round.myRole).toBe('SEEKING');
    // A host override would be recorded; here we accept the suggestion. Not started automatically:
    expect(next.body.round.state).toBe('READY');
    h.clock.advance(5 * MIN);
    T0 = await readyAndStart(morgan, taylor);
    const chaseStart = T0 + 10 * MIN;
    await track(taylor, morgan, T0, chaseStart + 15 * MIN, chaseStart);
    h.clock.set(chaseStart);
    await h.tick(sid, rid);
    h.clock.set(chaseStart + 10 * MIN);
    await h.tick(sid, rid);
    h.clock.set(chaseStart + 15 * MIN);
    const c1 = await capture(morgan);
    h.clock.set(chaseStart + 17 * MIN);
    const rej = await h.call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c1}/decision`, { decision: 'REJECT', reason: 'That is a stranger' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    let sv = await view(morgan);
    expect(sv.round.state).toBe('CHASE');
    expect(sv.round.lastClaimOutcome.status).toBe('REJECTED');
    // 2 minutes pending excluded: ping 2 moves from +20 to +22.
    expect(Date.parse(sv.round.nextPingAt)).toBe(chaseStart + 22 * MIN);
    await track(taylor, morgan, chaseStart + 15 * MIN, chaseStart + 22 * MIN, chaseStart);
    h.clock.set(chaseStart + 22 * MIN);
    await h.tick(sid, rid);
    h.clock.set(chaseStart + 22 * MIN + 30_000);
    const c2 = await capture(morgan);
    h.clock.set(chaseStart + 23 * MIN);
    const ok = await h.call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c2}/decision`, { decision: 'CONFIRM' });
    expect(ok.status).toBe(200);
    // 22.5 wall minutes minus 2 pending = 20:30
    expect(ok.body.result.observedChaseSeconds).toBe(20 * 60 + 30);
    sv = await view(morgan);
    expect(sv.round.result.pingSlots).toBe(3);
  });

  it('rounds 3–4 alternate again, night completes, scorecard compares crews without round winners', async () => {
    for (const [hider, seeker, chaseMin] of [
      [morgan, taylor, 12],
      [taylor, morgan, 9],
    ] as const) {
      const next = await h.call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, {});
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      h.clock.advance(5 * MIN);
      T0 = await readyAndStart(morgan, taylor);
      const chaseStart = T0 + 10 * MIN;
      await track(hider, seeker, T0, chaseStart + chaseMin * MIN, chaseStart);
      h.clock.set(chaseStart);
      await h.tick(sid, rid);
      h.clock.set(chaseStart + chaseMin * MIN);
      await h.tick(sid, rid);
      const c = await capture(seeker);
      h.clock.advance(20_000);
      expect((await h.call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${c}/decision`, { decision: 'CONFIRM' })).status).toBe(200);
    }
    const v = await view(taylor);
    expect(v.session.status).toBe('COMPLETED');
    expect(v.previousRounds.map((b: any) => b.hidingTeam)).toEqual(['A', 'B', 'A', 'B']);
    const an = await h.call(taylor, 'GET', `/v1/sessions/${sid}/analytics`);
    expect(an.status).toBe(200);
    const sc = an.body.scorecard;
    expect(sc.teams.A.hideRoundCount).toBe(2);
    expect(sc.teams.A.hideSurvivalAverageSeconds).toBe(Math.round((26 * 60 + 12 * 60) / 2));
    expect(sc.teams.B.hideSurvivalAverageSeconds).toBe(Math.round((20 * 60 + 30 + 9 * 60) / 2));
    expect(sc.comparison.status).toBe('COMPARABLE');
    expect(sc.comparison.strongerHidingTeam).toBe('A');
    // Next round is not allowed after the planned 4.
    const fifth = await h.call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, {});
    expect(fifth.body.error.code).toBe('GAME_CLOSED');
  });

  it('exports CSV/JSON without GPS and person analytics are crew-attributed', async () => {
    const csv = await h.call(morgan, 'GET', `/v1/export/sessions/${sid}.csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.split('\n')[0]).toContain('hider_foot_total_m');
    expect(csv.body).not.toMatch(/39\.73|104\.99/);
    const json = await h.call(morgan, 'GET', `/v1/export/sessions/${sid}.json`);
    expect(JSON.stringify(json.body)).not.toMatch(/latitude|longitude/);
    const people = await h.call(morgan, 'GET', '/v1/people?q=casey');
    const casey = people.body.people[0];
    expect(casey.displayName).toBe('Casey');
    const stats = await h.call(morgan, 'GET', `/v1/analytics/people/${casey.id}`);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.analytics.attribution).toBe('CREW_LEVEL');
    expect(stats.body.analytics.roundsCrewHid).toBe(2);
    expect(stats.body.analytics.pairedNights.stronger).toBe(1);
    const list = await h.call(taylor, 'GET', '/v1/sessions?q=casey');
    expect(list.body.items.map((s: any) => s.id)).toContain(sid);
  });
});
