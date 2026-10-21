/**
 * Real-time crews E2E against a RUNNING local stack (scripts/dev.sh): real wall
 * clock, real scheduler → private worker, real emulators, and a real Firestore
 * listener per phone (as the app has).
 *
 * Five phones, three crews: Crew A (Morgan + Casey) hides; Crew B (Taylor) and
 * Crew C (Phone4 + Phone5) seek in RACE mode. Both hider phones lose signal
 * across a ping deadline. Asserts:
 *   - the ping waits (seekers see "waiting", no coordinates), then releases the
 *     hiders' CURRENT position as soon as a fix gets through — never the backlog;
 *   - seekers never see an unreleased hider coordinate (REST or listener);
 *   - a RACE catch by Crew C is credited to Crew C only, and Crew B can't open its photo;
 *   - between rounds a phone moves crews and any crew hides next; any phone ends the night.
 * Reports per-phone listener snapshots and bytes, and REST calls, per minute.
 *
 *   cd backend && npm run e2e:crews      (after scripts/dev.sh and npm run seed:emulator)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot } from 'firebase/firestore';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085';
if (!(process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-manhunt').startsWith('demo-')) throw new Error('demo projects only');
const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')).accounts as { email: string; password: string; displayName: string }[];

type Json = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`, ...a);
let failures = 0;
function expect(cond: unknown, msg: string) {
  if (!cond) {
    failures++;
    console.error('  ✗', msg);
  } else console.log('  ✓', msg);
}

const health = { permission: 'WHEN_IN_USE', preciseLocation: true, trackingActive: true, backgroundSessionActive: true, lowPowerMode: false, batteryLevel: 0.8, networkReachable: true, appVersion: 'e2e', queuedSamples: 0, lastFixAgeSeconds: 2, lastFixAccuracyMeters: 6 };

// ---------------------------------------------------------------------------
// Phones: REST client with counters + a Firestore listener on its own view.
// ---------------------------------------------------------------------------

interface Phone {
  name: string;
  email: string;
  password: string;
  uid: string;
  token: string;
  calls: number;
  bytesIn: number;
  snapshots: number;
  snapshotBytes: number;
  latest: Json | null;
  stopListening?: () => void;
}

async function idp(path: string, body: unknown) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/${path}?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()) as { idToken?: string; localId?: string };
}

async function phone(name: string, email: string, password: string): Promise<Phone> {
  let s = await idp('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  if (!s.idToken) {
    const up = await idp('accounts:signUp', { email, password, returnSecureToken: true });
    await idp('accounts:update', { idToken: up.idToken, displayName: name });
    s = await idp('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  }
  const p: Phone = { name, email, password, uid: s.localId!, token: s.idToken!, calls: 0, bytesIn: 0, snapshots: 0, snapshotBytes: 0, latest: null };
  await call(p, 'PATCH', '/v1/me', { displayName: name });
  return p;
}

async function call(p: Phone, method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${p.token}`, ...(raw ? { 'content-type': 'image/jpeg' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  p.calls++;
  p.bytesIn += text.length;
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, body: parsed };
}

async function listen(p: Phone, sid: string) {
  const app = initializeApp({ projectId: 'demo-manhunt', apiKey: 'demo-key', authDomain: 'localhost' }, `phone-${p.name}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${AUTH}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [host, port] = FS.split(':');
  connectFirestoreEmulator(db, host!, Number(port));
  await signInWithEmailAndPassword(auth, p.email, p.password);
  p.stopListening = onSnapshot(doc(db, 'sessions', sid, 'views', p.uid), (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    p.snapshots++;
    p.snapshotBytes += JSON.stringify(data).length;
    p.latest = data;
  });
}

const tinyJpeg = () => {
  const seg = (m: number, b: Buffer) => { const l = Buffer.alloc(2); l.writeUInt16BE(b.length + 2); return Buffer.concat([Buffer.from([0xff, m]), l, b]); };
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0xd2, 0xcf, 0x20, 0xff, 0xd9])]);
};

// ---------------------------------------------------------------------------
// Night setup
// ---------------------------------------------------------------------------

const morgan = await phone('Morgan', seed[0]!.email, seed[0]!.password);
const taylor = await phone('Taylor', seed[1]!.email, seed[1]!.password);
const casey = await phone('Casey', seed[2]!.email, seed[2]!.password);
const p4 = await phone('Phone4', 'phone4@demo.manhunt.test', 'emulator-only-phone4-3Z8');
const p5 = await phone('Phone5', 'phone5@demo.manhunt.test', 'emulator-only-phone5-6Y1');
const phones = [morgan, casey, taylor, p4, p5];

const created = await call(morgan, 'POST', '/v1/sessions', {
  title: `Crews E2E ${new Date().toISOString().slice(0, 16)}`,
  scheduledDate: new Date().toISOString().slice(0, 10),
  myTeam: 'A',
  teams: { A: { name: 'Owls', roster: [{ displayName: 'Jules' }] }, B: { name: 'Foxes', roster: [] }, C: { name: 'Ravens', roster: [] } },
  firstHidingTeam: 'A',
  seekMode: 'RACE',
  rules: { headStartSeconds: 60, pingIntervalSeconds: 60, confirmationTimeoutSeconds: 120, maxPingGpsAgeSeconds: 30 },
});
expect(created.status === 200, 'night created with three crews');
const sid = created.body.sessionId as string;
const code = created.body.session.joinCode as string;
for (const [p, k] of [[casey, 'A'], [taylor, 'B'], [p4, 'C'], [p5, 'C']] as const) {
  const r = await call(p, 'POST', '/v1/invites/redeem', { code, teamKey: k });
  expect(r.status === 200 && r.body.session.myTeam === k, `${p.name} joined crew ${k} with the night code`);
}
await Promise.all(phones.map((p) => listen(p, sid)));
for (const p of phones) await call(p, 'POST', `/v1/sessions/${sid}/consent`, { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true });
for (const p of [casey, taylor, p5]) await call(p, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
const rid = (await call(p4, 'GET', `/v1/sessions/${sid}`)).body.round.id as string;
const start = await call(p4, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
expect(start.status === 200, 'a seeking phone started the round (no lead phone)');
const roundStartAt = Date.parse((await call(morgan, 'GET', `/v1/sessions/${sid}`)).body.round.roundStartAt);
// Measure the round only; the test's own polling goes through separate counters.
for (const p of phones) Object.assign(p, { calls: 0, bytesIn: 0, snapshots: 0, snapshotBytes: 0 });
const observer = (p: Phone): Phone => ({ ...p, name: `${p.name}-observer` });
const watchers = [observer(taylor), observer(p4)];
const chaseStart = roundStartAt + 60_000;
const outage: [number, number] = [chaseStart + 30_000, chaseStart + 95_000];
log('round started; ping 1 due at chase+60 s, hiders offline chase+30…95 s');

// ---------------------------------------------------------------------------
// GPS: every phone records every 5 s and uploads every 15 s (like the app).
// Hider phones queue while offline and flush the backlog on reconnect.
// ---------------------------------------------------------------------------

const hiderCoords = new Set<number>();
const backlogCoords = new Set<number>();
let stop = false;
const recorder = (p: Phone, hider: boolean, offset: number) => (async () => {
  let queue: Json[] = [];
  let lastUpload = 0;
  while (!stop) {
    const t = Date.now();
    const dt = (t - roundStartAt) / 1000;
    const lat = hider ? 39.7612345 + offset * 1e-4 : 39.70 + Math.max(0, (t - chaseStart) / 1000) * (12 / 111_000) + offset * 1e-3;
    const lon = hider ? -104.9812345 + dt * (1.4 / 85_300) : -105.0 - offset * 1e-3;
    if (hider) hiderCoords.add(lat).add(lon);
    queue.push({ pointId: randomUUID(), recordedAt: new Date(t - 500).toISOString(), latitude: lat, longitude: lon, horizontalAccuracyMeters: 6 });
    const offline = hider && t >= outage[0] && t < outage[1];
    if (offline) for (const s of queue) backlogCoords.add(s.latitude).add(s.longitude);
    if (!offline && t - lastUpload >= 15_000) {
      const r = await call(p, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, { batchId: randomUUID(), sentAt: new Date().toISOString(), samples: queue, health });
      if (r.status === 200) queue = [];
      lastUpload = t;
    }
    await sleep(5000);
  }
})();
const uploaders = [recorder(morgan, true, 0), recorder(casey, true, 1), recorder(taylor, false, 0), recorder(p4, false, 1), recorder(p5, false, 2)];

// Seekers' views (REST and listener) must never contain an unreleased hider coordinate.
let leaks = 0;
const checkLeaks = (v: Json) => {
  const released = new Set(((v?.round?.pins ?? []) as Json[]).flatMap((p) => [p.latitude, p.longitude]));
  const nums = (JSON.stringify(v).match(/-?\d+\.\d{5,}/g) ?? []).map(Number);
  leaks += nums.filter((n) => hiderCoords.has(n) && !released.has(n)).length;
};
let sawWaiting = false;
let waitingHadCoords = false;
const observe = async (until: number) => {
  while (Date.now() < until) {
    for (const [i, w] of watchers.entries()) {
      const v = (await call(w, 'GET', `/v1/sessions/${sid}`)).body;
      checkLeaks(v);
      checkLeaks([taylor, p4][i]!.latest);
      if (v.round?.waitingPing) {
        sawWaiting = true;
        if (/latitude|longitude/.test(JSON.stringify(v.round.waitingPing))) waitingHadCoords = true;
      }
    }
    await sleep(2000);
  }
};

await observe(chaseStart + 90_000);
expect(sawWaiting, 'seekers saw ping 1 waiting while the hiders were offline');
expect(!waitingHadCoords, 'the waiting ping carried no coordinates');
await observe(outage[1] + 12_000);
const after = (await call(watchers[0]!, 'GET', `/v1/sessions/${sid}`)).body.round;
const late = (after.pingLog as Json[]).find((p) => p.index === 1);
expect(late?.status === 'RELEASED' && late?.delayed === true, 'ping 1 released late once a hider fix got through');
const pin1 = (after.pins as Json[]).find((p) => p.index === 1) ?? (after.pins as Json[]).at(-1);
expect(pin1 && Date.parse(pin1.observedAt) >= outage[1] - 6_000, `released the current position (recorded ${pin1 ? ((Date.parse(pin1.observedAt) - outage[1]) / 1000).toFixed(1) : '?'} s from reconnect), not the backlog`);
expect(pin1 && !backlogCoords.has(pin1.longitude), 'no backlog coordinate was released');
const releasedAfterReconnect = ((late ? Date.parse(late.releasedAt) : Infinity) - outage[1]) / 1000;
log(`ping 1 released ${releasedAfterReconnect.toFixed(1)} s after the hiders reconnected`);
expect(releasedAfterReconnect < 20, 'released within one upload cycle of reconnecting');
await observe(Date.now() + 6_000);
expect(leaks === 0, `seekers never saw an unreleased hider coordinate (${leaks} leaks)`);

// RACE catch by Crew C; Crew B can't open the photo; a hider phone confirms.
const init = await call(p5, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
await call(p5, 'PUT', init.body.uploadPath, undefined, tinyJpeg());
const done = await call(p5, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId });
expect(done.status === 200, 'Crew C submitted a catch');
expect((await call(taylor, 'GET', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/photo`)).status === 404, "RACE: Crew B can't open Crew C's catch photo");
const dec = await call(casey, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' });
expect(dec.status === 200 && JSON.stringify(dec.body.result.catchCreditTeams) === '["C"]', 'the second hider phone confirmed; credit goes to Crew C only');
const roundMinutes = (Date.now() - roundStartAt) / 60_000;
stop = true;
await Promise.all(uploaders);

// Between rounds: move a phone, any crew hides next, any phone ends the night.
await sleep(2000);
const mv = await call(taylor, 'PATCH', `/v1/sessions/${sid}/setup`, { moves: [{ uid: casey.uid, teamKey: 'B' }] });
expect(mv.status === 200, 'Casey moved from Owls to Foxes between rounds');
const next = await call(p4, 'POST', `/v1/sessions/${sid}/next-round`, { hidingTeam: 'C', seekMode: 'TOGETHER' });
expect(next.status === 200 && next.body.round.hidingTeam === 'C' && next.body.round.state === 'READY', 'round 2 set up with Ravens hiding, not auto-started');
const end = await call(taylor, 'POST', `/v1/sessions/${sid}/complete`, {});
expect(end.status === 200, 'a phone ended the night');
expect((await call(p5, 'GET', `/v1/sessions/${sid}`)).body.session.status === 'COMPLETED', 'night is over; the unstarted round was discarded');
await sleep(1500);
for (const p of phones) p.stopListening?.();

// ---------------------------------------------------------------------------
// Bandwidth (round only: start → catch confirmed)
// ---------------------------------------------------------------------------

console.log(`\nPer phone over ${roundMinutes.toFixed(1)} min of round (listener snapshots / KB, REST calls / KB):`);
for (const p of phones) {
  console.log(`  ${p.name.padEnd(7)} ${(p.snapshots / roundMinutes).toFixed(1).padStart(5)} snapshots/min  ${(p.snapshotBytes / 1024 / roundMinutes).toFixed(1).padStart(6)} KB/min   ${(p.calls / roundMinutes).toFixed(1).padStart(5)} calls/min  ${(p.bytesIn / 1024 / roundMinutes).toFixed(1).padStart(6)} KB/min`);
}
console.log(failures ? `E2E FAILED (${failures})` : 'E2E PASSED', `session ${sid}`);
process.exit(failures ? 1 : 0);
