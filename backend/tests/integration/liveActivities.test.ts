import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveActivityService, type LiveActivityPush } from '../../src/services/liveActivities.js';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * Live Activities end to end (ADR 0017) against the emulators, with a recording
 * ActivityKit transport: push-to-start on the phones that didn't start the round,
 * updates on every round transition rendered from each phone's own view (with its
 * clock offset), the round's notifications carried as activity alerts instead of
 * duplicate pushes, the end with a 15-minute dismissal, and token cleanup.
 */
let h: Harness;
let morgan: TestUser; // Crew A (hides round 1), starts the round
let drew: TestUser; // Crew A, second phone
let taylor: TestUser; // Crew B (seeks)
let outsider: TestUser;
let sid: string;
let rid: string;
let T0: number;

const HIDER = { lat: 39.761234, lon: -104.981234 };
const tokenOf = (u: TestUser, kind: 'start' | 'activity') => Buffer.from(`${kind}-${u.uid}`).toString('hex');
const deviceOf = (u: TestUser) => `device-${u.uid}`;

/** Every number anywhere in an object. */
function numbers(o: unknown, out: number[] = []): number[] {
  if (typeof o === 'number') out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => numbers(x, out));
  else if (o && typeof o === 'object') Object.values(o).forEach((x) => numbers(x, out));
  return out;
}

const sentSince = (n: number) => h.liveActivities.sent.slice(n);
const toPhone = (pushes: LiveActivityPush[], u: TestUser) => pushes.filter((p) => p.activityToken === tokenOf(u, 'activity') || p.activityToken === tokenOf(u, 'start'));

async function hiderUploads(from: number, to: number) {
  for (let t = from; t < to; t += 20_000) {
    h.clock.set(t + 20_000);
    for (const [i, u] of [morgan, drew].entries()) {
      const pts: [number, number, number][] = [];
      for (let s = t + i * 3000; s < t + 20_000; s += 10_000) pts.push([s, HIDER.lat + (s - T0) * 1e-9, HIDER.lon]);
      expect((await h.call(u, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, pts))).status).toBe(200);
    }
  }
}

const register = (u: TestUser, body: Record<string, unknown>, round = rid, device = deviceOf(u)) => h.call(u, 'PUT', `/v1/sessions/${sid}/rounds/${round}/live-activity/${device}`, body);

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  morgan = await h.createUser('Morgan');
  drew = await h.createUser('Drew');
  taylor = await h.createUser('Taylor');
  outsider = await h.createUser('Outsider');
  const s = await h.call(morgan, 'POST', '/v1/sessions', {
    title: 'Live night',
    scheduledDate: '2026-10-22',
    myTeam: 'A',
    teams: { A: { name: 'Foxes', roster: [{ displayName: 'Ana' }] }, B: { name: 'Hounds', roster: [{ displayName: 'Bo' }] } },
    firstHidingTeam: 'A',
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120 },
  });
  sid = s.body.sessionId;
  rid = s.body.round.id;
  const inv = await h.call(morgan, 'POST', `/v1/sessions/${sid}/invites`, {});
  await h.call(drew, 'POST', '/v1/invites/redeem', { code: inv.body.code, teamKey: 'A' });
  await h.call(taylor, 'POST', '/v1/invites/redeem', { code: inv.body.code, teamKey: 'B' });
  for (const u of [morgan, drew, taylor]) {
    expect((await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody)).status).toBe(200);
    // Start token first, then the FCM token: registering one must not wipe the other.
    expect((await h.call(u, 'POST', '/v1/devices/live-activity-token', { deviceId: deviceOf(u), pushToStartToken: tokenOf(u, 'start') })).status).toBe(200);
    expect((await h.call(u, 'POST', '/v1/devices/push-token', { deviceId: deviceOf(u), fcmToken: `fcm-token-${u.uid}`, apnsEnvironment: 'development' })).status).toBe(200);
  }
  for (const u of [morgan, taylor]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('Live Activities', () => {
  it('a token can be registered only for a round in progress that the phone plays, with a strict body', async () => {
    const ok = { pushToken: tokenOf(morgan, 'activity'), clockOffsetMs: 0 };
    expect((await register(morgan, ok)).body.error.code).toBe('STALE_PHASE'); // READY: nothing to show yet
    expect((await h.call(morgan, 'POST', '/v1/devices/live-activity-token', { deviceId: deviceOf(morgan), pushToStartToken: 'not hex!' })).status).toBe(400);
    const dev = (await h.deps.db.collection('users').doc(taylor.uid).collection('devices').doc(deviceOf(taylor)).get()).data()!;
    expect(dev).toMatchObject({ fcmToken: `fcm-token-${taylor.uid}`, liveActivityStartToken: tokenOf(taylor, 'start') });
  });

  it('starting the round push-starts the activity on the other phones, with the start notification as its alert', async () => {
    h.clock.advance(1000);
    const before = h.liveActivities.sent.length;
    const res = await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    T0 = h.clock.now();
    const starts = sentSince(before);
    // Morgan started it in the foreground and starts its own activity; Drew and Taylor get push-to-start.
    expect(toPhone(starts, morgan)).toEqual([]);
    for (const [u, role, crew, crewName] of [
      [drew, 'HIDING', 'A', 'Foxes'],
      [taylor, 'SEEKING', 'B', 'Hounds'],
    ] as const) {
      const [p] = toPhone(starts, u);
      expect(p).toMatchObject({
        event: 'start',
        activityToken: tokenOf(u, 'start'),
        fcmToken: `fcm-token-${u.uid}`,
        priority: 10,
        attributes: { sessionId: sid, roundId: rid, roundIndex: 1, role, crew, crewName },
        contentState: { phase: 'HEAD_START', headStartEndsAt: (T0 + 2 * MIN) / 1000 },
        alert: { title: 'Round 1 started' },
      });
      expect(p!.staleDate).toBe((T0 + 2 * MIN) / 1000 + 90);
      expect(h.notifier.liveActivityAlerts).toContainEqual({ uid: u.uid, deviceId: deviceOf(u), roundId: rid, kind: 'ROUND_STARTED' });
    }
    // The regular push still goes to Morgan (no activity alert there).
    expect(h.notifier.liveActivityAlerts.some((a) => a.uid === morgan.uid)).toBe(false);
  });

  it('phones register their activity tokens; outsiders and malformed bodies are refused', async () => {
    expect((await register(morgan, { pushToken: tokenOf(morgan, 'activity'), clockOffsetMs: 0 })).status).toBe(200);
    expect((await register(drew, { pushToken: tokenOf(drew, 'activity'), clockOffsetMs: -400 })).status).toBe(200);
    expect((await register(taylor, { pushToken: tokenOf(taylor, 'activity'), clockOffsetMs: 1500 })).status).toBe(200);
    expect((await register(outsider, { pushToken: tokenOf(outsider, 'activity'), clockOffsetMs: 0 })).status).toBe(404);
    expect((await register(taylor, { pushToken: tokenOf(taylor, 'activity'), clockOffsetMs: 0, role: 'HIDING' })).status).toBe(400);
    expect((await register(taylor, { pushToken: 'zz', clockOffsetMs: 0 })).status).toBe(400);
    expect((await register(taylor, { pushToken: tokenOf(taylor, 'activity'), clockOffsetMs: 10 ** 9 })).status).toBe(400);
    expect((await register(taylor, { pushToken: tokenOf(taylor, 'activity'), clockOffsetMs: 0 }, rid, 'bad/device')).status).toBe(404);
    const regs = await h.deps.db.collection('sessions').doc(sid).collection('liveActivities').get();
    expect(regs.docs.map((d) => d.id).sort()).toEqual([morgan, drew, taylor].map((u) => `${u.uid}_${deviceOf(u)}`).sort());
  });

  it('chase start updates every activity from its own view: alerts ride along, timers carry each phone’s clock offset, no coordinates', async () => {
    const chaseStart = T0 + 2 * MIN;
    const before = h.liveActivities.sent.length;
    const alertsBefore = h.notifier.liveActivityAlerts.length;
    await hiderUploads(T0, chaseStart);
    expect(sentSince(before)).toEqual([]); // health uploads change nothing on the Lock Screen
    h.clock.set(chaseStart);
    expect((await h.tick(sid, rid)).status).toBe(200);
    const pushes = sentSince(before);
    const [m] = toPhone(pushes, morgan);
    const [d] = toPhone(pushes, drew);
    const [t] = toPhone(pushes, taylor);
    for (const p of [m, d, t]) expect(p).toMatchObject({ event: 'update', priority: 10, contentState: { phase: 'CHASE', nextPingIndex: 1 } });
    expect(m!.alert?.title).toBe('The chase is on'); // CHASE_STARTED to the hiders
    expect(t!.alert?.title).toBe('The chase is on'); // ping 0 released to the seekers
    expect(m!.contentState.chaseStartedAt).toBe(chaseStart / 1000);
    expect(d!.contentState.chaseStartedAt).toBe((chaseStart - 400) / 1000);
    expect(t!.contentState.chaseStartedAt).toBe((chaseStart + 1500) / 1000);
    expect(t!.contentState.nextPingAt).toBe((chaseStart + 2 * MIN + 1500) / 1000);
    expect(t!.contentState.lastPing).toMatchObject({ index: 0, missing: false });
    const hiderCoords = new Set<number>();
    for (let s = T0; s <= chaseStart; s += 1000) hiderCoords.add(HIDER.lat + (s - T0) * 1e-9);
    hiderCoords.add(HIDER.lon);
    for (const p of pushes) expect(numbers(p).filter((n) => hiderCoords.has(n))).toEqual([]);
    expect(JSON.stringify(pushes)).not.toMatch(/latitude|longitude/);
    const delivered = h.notifier.liveActivityAlerts.slice(alertsBefore).map((a) => `${a.uid}:${a.kind}`).sort();
    expect(delivered).toEqual([`${drew.uid}:CHASE_STARTED`, `${morgan.uid}:CHASE_STARTED`, `${taylor.uid}:PING_RELEASED`].sort());
    // Re-running the same tick sends nothing new (idempotent).
    const n = h.liveActivities.sent.length;
    await h.tick(sid, rid);
    expect(h.liveActivities.sent.length).toBe(n);
  });

  it('a dead activity token is dropped and that phone gets the regular push instead', async () => {
    h.liveActivities.invalid.add(tokenOf(drew, 'activity'));
    const alertsBefore = h.notifier.liveActivityAlerts.length;
    await hiderUploads(T0 + 2 * MIN, T0 + 4 * MIN);
    h.clock.set(T0 + 4 * MIN);
    await h.tick(sid, rid);
    const regs = await h.deps.db.collection('sessions').doc(sid).collection('liveActivities').get();
    expect(regs.docs.map((x) => x.get('uid')).sort()).toEqual([morgan.uid, taylor.uid].sort());
    // Ping 1: seekers get it on their activity; hiders' content changes quietly (no hider notification).
    const recent = h.notifier.liveActivityAlerts.slice(alertsBefore);
    expect(recent).toEqual([{ uid: taylor.uid, deviceId: deviceOf(taylor), roundId: rid, kind: 'PING_RELEASED' }]);
    const [m] = toPhone(sentSince(h.liveActivities.sent.length - 2), morgan);
    expect(m).toMatchObject({ event: 'update', priority: 5, contentState: { lastPing: { index: 1 } } });
    expect(m!.alert).toBeUndefined();
  });

  it('APNs rejecting the credentials pauses activity pushes; alerts go out as regular pushes, and updates resume once fixed', async () => {
    // 2026-10-22: every activity push failed with messaging/third-party-auth-error, one by one, on every change.
    h.liveActivities.rejectCredentials = true;
    const alertsBefore = h.notifier.liveActivityAlerts.length;
    const pushesBefore = h.notifier.sent.length;
    await hiderUploads(T0 + 4 * MIN, T0 + 6 * MIN);
    h.clock.set(T0 + 6 * MIN);
    await h.tick(sid, rid);
    const attempts = h.liveActivities.attempts;
    expect(h.notifier.liveActivityAlerts.length).toBe(alertsBefore);
    expect(h.notifier.sent.slice(pushesBefore).some((n) => n.kind === 'PING_RELEASED' && n.toUids.includes(taylor.uid))).toBe(true);
    // Paused: the next change doesn't try again.
    await hiderUploads(T0 + 6 * MIN, T0 + 8 * MIN);
    h.clock.set(T0 + 8 * MIN);
    await h.tick(sid, rid);
    expect(h.liveActivities.attempts).toBe(attempts);
    // Nothing was marked as sent, so the next change after the fix brings each activity up to date.
    h.liveActivities.rejectCredentials = false;
    LiveActivityService.resetBackoff();
  });

  it('a catch claim goes to the hiders’ activities as an alert; confirming ends every activity with a 15-minute dismissal', async () => {
    const init = await h.call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
    await h.call(taylor, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
    let before = h.liveActivities.sent.length;
    h.clock.advance(5_000);
    expect((await h.call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId })).status).toBe(200);
    const submitted = h.clock.now();
    const [m] = toPhone(sentSince(before), morgan);
    const [t] = toPhone(sentSince(before), taylor);
    expect(m).toMatchObject({ event: 'update', alert: { title: 'Photo catch submitted' }, contentState: { phase: 'CAPTURE_PENDING', claim: { crew: 'B', expiresAt: (submitted + 2 * MIN) / 1000 } } });
    expect(t!.contentState).toMatchObject({ phase: 'CAPTURE_PENDING', claim: { crew: 'B', expiresAt: (submitted + 2 * MIN + 1500) / 1000 } });
    expect(JSON.stringify(m)).not.toContain('photo');

    before = h.liveActivities.sent.length;
    h.clock.advance(20_000);
    expect((await h.call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' })).status).toBe(200);
    const now = h.clock.now();
    const ends = sentSince(before);
    expect(ends.map((p) => p.event)).toEqual(['end', 'end']);
    const [me] = toPhone(ends, morgan);
    const [te] = toPhone(ends, taylor);
    expect(me).toMatchObject({ alert: { title: 'Catch confirmed' }, dismissalDate: (now + 15 * MIN) / 1000, contentState: { phase: 'ENDED', outcome: { result: 'CAUGHT', creditCrews: ['B'] } } });
    expect(te!.dismissalDate).toBe((now + 15 * MIN + 1500) / 1000);
    expect(te!.contentState.chaseElapsed).toBe(me!.contentState.chaseElapsed);
    // Nothing left to update: registrations are gone.
    expect((await h.deps.db.collection('sessions').doc(sid).collection('liveActivities').get()).size).toBe(0);
    expect((await register(taylor, { pushToken: tokenOf(taylor, 'activity'), clockOffsetMs: 0 })).body.error.code).toBe('STALE_PHASE');
  });

  it('turning Live Activities off clears the start token; a dismissed activity unregisters; revoking ends every activity at once', async () => {
    expect((await h.call(drew, 'POST', '/v1/devices/live-activity-token', { deviceId: deviceOf(drew), pushToStartToken: null })).status).toBe(200);
    const nr = await h.call(taylor, 'POST', `/v1/sessions/${sid}/next-round`, {});
    expect(nr.status, JSON.stringify(nr.body)).toBe(200);
    rid = nr.body.round.id;
    h.clock.advance(MIN);
    for (const u of [drew, taylor]) expect((await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() })).status).toBe(200);
    const before = h.liveActivities.sent.length;
    expect((await h.call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true })).status).toBe(200);
    // Taylor started; Drew turned Live Activities off; only Morgan's phone is push-started.
    expect(sentSince(before).map((p) => p.activityToken)).toEqual([tokenOf(morgan, 'start')]);

    for (const u of [morgan, taylor]) expect((await register(u, { pushToken: tokenOf(u, 'activity'), clockOffsetMs: 0 })).status).toBe(200);
    expect((await h.call(morgan, 'DELETE', `/v1/sessions/${sid}/rounds/${rid}/live-activity/${deviceOf(morgan)}`)).status).toBe(200);
    const left = await h.deps.db.collection('sessions').doc(sid).collection('liveActivities').get();
    expect(left.docs.map((d) => d.get('uid'))).toEqual([taylor.uid]);

    const n = h.liveActivities.sent.length;
    expect((await h.call(morgan, 'POST', `/v1/sessions/${sid}/revoke`, {})).status).toBe(200);
    const ends = sentSince(n);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ event: 'end', activityToken: tokenOf(taylor, 'activity'), dismissalDate: 0, contentState: { phase: 'ENDED', outcome: { result: 'ABORTED' } } });
    expect((await h.deps.db.collection('sessions').doc(sid).collection('liveActivities').get()).size).toBe(0);
  });
});
