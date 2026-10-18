/**
 * Real-time two-operator E2E against a RUNNING local stack (scripts/dev.sh):
 * real wall clock, real in-process scheduler → private worker HTTP, real
 * emulators. Two operators (seeded emulator accounts) play one round with a
 * 60 s head start and 60 s pings, uploading GPS every 5 s like the app does.
 *
 * Measures: first-ping dispatch latency vs. chase start, ping cadence, that the
 * seeker never sees hider coordinates other than released pins, and that the
 * official catch time equals server submission time.
 *
 *   cd backend && npm run e2e:two-operators
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')) as { accounts: { email: string; password: string }[] };

type Json = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function token(i: number) {
  const a = seed.accounts[i]!;
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password, returnSecureToken: true }),
  });
  const j = (await r.json()) as { idToken?: string };
  if (!j.idToken) throw new Error('Seed accounts missing — run npm run seed:emulator');
  return j.idToken;
}

async function call(tok: string, method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(raw ? { 'content-type': 'image/jpeg' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, body: parsed };
}

const health = { permission: 'WHEN_IN_USE', preciseLocation: true, trackingActive: true, backgroundSessionActive: true, lowPowerMode: false, batteryLevel: 0.8, networkReachable: true, appVersion: 'e2e', queuedSamples: 0, lastFixAgeSeconds: 2, lastFixAccuracyMeters: 6 };
function tinyJpeg(): Buffer {
  const seg = (marker: number, payload: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=39.7')),
    seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])),
    seg(0xc0, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])),
    seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0xd2, 0xcf, 0x20, 0xff, 0xd9]),
  ]);
}

function expect(cond: unknown, msg: string) {
  if (!cond) {
    console.error('✗', msg);
    process.exitCode = 1;
    throw new Error(msg);
  } else console.log('  ✓', msg);
}

const host = await token(0); // Morgan — Crew A, hides round 1
const guest = await token(1); // Taylor — Crew B, seeks round 1
const me = (await call(host, 'GET', '/v1/me')).body;
const created = await call(host, 'POST', '/v1/sessions', {
  title: `Realtime E2E ${new Date().toISOString().slice(0, 16)}`,
  scheduledDate: new Date().toISOString().slice(0, 10),
  myTeam: 'A',
  teams: { A: { name: 'Crew A', roster: [{ personId: me.profile.selfPersonId, displayName: 'Morgan' }, { displayName: 'Casey' }] }, B: { name: 'Crew B', roster: [{ displayName: 'Riley' }] } },
  rules: { headStartSeconds: 60, pingIntervalSeconds: 60, totalRounds: 2, confirmationTimeoutSeconds: 60 },
});
expect(created.status === 200, 'host created the night');
const sid = created.body.sessionId as string;
const inv = await call(host, 'POST', `/v1/sessions/${sid}/invites`, {});
expect((await call(guest, 'POST', '/v1/invites/redeem', { code: inv.body.code })).status === 200, 'second operator joined by code');
for (const t of [host, guest]) {
  await call(t, 'POST', `/v1/sessions/${sid}/consent`, { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true });
  await call(t, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
}
const rid = (await call(host, 'GET', `/v1/sessions/${sid}`)).body.round.id as string;
const start = await call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false });
expect(start.status === 200, 'host started round 1 (server-timed)');
const roundStartAt = Date.parse((await call(host, 'GET', `/v1/sessions/${sid}`)).body.round.roundStartAt);
const chaseStart = roundStartAt + 60_000;
log('round started; chase (and first ping) due at', new Date(chaseStart).toISOString());

// GPS: hider walks east 1.5 m/s with a distinctive base; seeker drives north 12 m/s.
const hiderCoords: number[] = [];
let stop = false;
const uploader = (async () => {
  while (!stop) {
    const t = Date.now();
    const dt = (t - roundStartAt) / 1000;
    const hLat = 39.7612345, hLon = -104.9812345 + dt * (1.5 / 85_300);
    hiderCoords.push(hLat, hLon);
    const mk = (lat: number, lon: number) => ({ batchId: randomUUID(), sentAt: new Date().toISOString(), samples: [{ pointId: randomUUID(), recordedAt: new Date(t - 800).toISOString(), latitude: lat, longitude: lon, horizontalAccuracyMeters: 6 }], health });
    await Promise.all([
      call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, mk(hLat, hLon)),
      call(guest, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, mk(39.70 + Math.max(0, (t - chaseStart) / 1000) * (12 / 111_000), -105.0)),
    ]);
    await sleep(5000);
  }
})();

// Seeker observes its own view every second; record when pings appear.
const pingSeenAt = new Map<number, number>();
let leaks = 0;
let sawPinDuringHeadStart = false;
const observe = async (until: number) => {
  while (Date.now() < until) {
    const v = (await call(guest, 'GET', `/v1/sessions/${sid}`)).body;
    const pins = (v.round?.pins ?? []) as { index: number; latitude: number; longitude: number }[];
    if (v.round?.state === 'HEAD_START' && pins.length) sawPinDuringHeadStart = true;
    for (const p of v.round?.pingLog ?? []) if (!pingSeenAt.has(p.index)) pingSeenAt.set(p.index, Date.now());
    const released = new Set(pins.flatMap((p) => [p.latitude, p.longitude]));
    const nums = JSON.stringify(v).match(/-?\d+\.\d{5,}/g) ?? [];
    leaks += nums.filter((n) => hiderCoords.includes(Number(n)) && !released.has(Number(n))).length;
    await sleep(1000);
  }
};

await observe(chaseStart + 95_000);
expect(!sawPinDuringHeadStart, 'seeker saw no hider pin during the head start');
const firstLatency = (pingSeenAt.get(0) ?? Infinity) - chaseStart;
const secondLatency = (pingSeenAt.get(1) ?? Infinity) - (chaseStart + 60_000);
log(`ping 0 visible to seeker ${(firstLatency / 1000).toFixed(1)} s after chase start; ping 1 ${(secondLatency / 1000).toFixed(1)} s after its deadline`);
expect(firstLatency >= 0 && firstLatency < 5_000, 'first ping released at chase start (seen within 5 s incl. 1 s polling)');
expect(secondLatency >= 0 && secondLatency < 5_000, 'second ping released one interval later');
const v = (await call(guest, 'GET', `/v1/sessions/${sid}`)).body;
expect(v.round.pins.length === 1 && v.round.pins[0].index === 1, 'history count 1 → only the latest pin is visible');
expect(v.round.pins[0].ageSeconds <= 60, `released pin sample age ${v.round.pins[0].ageSeconds}s ≤ 60s`);
expect(leaks === 0, 'seeker view never contained unreleased hider coordinates');

// Photo catch at ~chase+95 s; hider confirms 8 s later.
const init = await call(guest, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
const up = await call(guest, 'PUT', init.body.uploadPath, undefined, tinyJpeg());
expect(up.status === 200, 'photo uploaded (metadata stripped server-side)');
const before = Date.now();
const done = await call(guest, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId });
expect(done.status === 200, 'catch claim accepted');
const submittedAt = Date.parse(done.body.submittedAt);
await sleep(8000);
const dec = await call(host, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' });
expect(dec.status === 200 && dec.body.roundState === 'COMPLETED', 'hider confirmed the catch');
const official = dec.body.result.observedChaseSeconds as number;
const expected = Math.round((submittedAt - chaseStart) / 1000);
log(`official chase time ${official}s; submitted ${((submittedAt - before) / 1000).toFixed(2)}s after request; confirmation 8s later`);
expect(Math.abs(official - expected) <= 1, 'official time = server submission time (not confirmation time)');
stop = true;
await uploader;

await sleep(1500);
const sum = (await call(guest, 'GET', `/v1/sessions/${sid}/rounds/${rid}/summary`)).body;
log(`recap: hider on foot ${sum.result.hidingDistanceTotalMeters} m (chase ${sum.result.hidingDistanceChaseMeters} m), seeker by car ${sum.result.seekingDistanceChaseMeters} m, coverage ${sum.result.gpsCoverageFractionHider}/${sum.result.gpsCoverageFractionSeeker}`);
expect(sum.result.hidingDistanceTotalMeters > 150 && sum.result.seekingDistanceChaseMeters > 800, 'distances computed separately for walking and driving');
const next = await call(host, 'POST', `/v1/sessions/${sid}/next-round`, {});
expect(next.status === 200 && next.body.round.hidingTeam === 'B' && next.body.round.state === 'READY', 'round 2 created with roles swapped and NOT auto-started');
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED', `session ${sid}`);
