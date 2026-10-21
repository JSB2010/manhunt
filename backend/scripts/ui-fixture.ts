/**
 * Design QA fixture: puts the emulator demo accounts into one game state so the
 * iOS app can be reviewed screen by screen (light/dark, Dynamic Type, VoiceOver).
 * The simulator signs in as Morgan (Crew A, host); this script drives Taylor
 * (Crew B) through the real API. Emulator/demo project only.
 *
 *   npx tsx scripts/ui-fixture.ts <state> [seek|hide] [two|three]
 *     lobby      Morgan hosts; Taylor joined and is Ready; Morgan hasn't accepted the disclosure
 *     headstart  round 1 running, 10 min head start
 *     chase      head start over, released pings (keeps uploading Taylor's GPS until stopped)
 *     pending    a catch claim waiting for the hiding operator
 *     paused     safety pause requested by Taylor
 *     recap      round 1 caught and confirmed (both routes recorded)
 *     night      a finished two-round night
 *   seek (default): Morgan's crew seeks round 1. hide: Morgan's crew hides.
 *   two: Casey joins Morgan's crew as a second phone. three: Casey plays a third crew
 *   (two seeking crews, RACE). Default: two crews, one phone each.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (!(process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-manhunt').startsWith('demo-')) throw new Error('demo projects only');
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')).accounts as { email: string; password: string }[];
const state = process.argv[2] ?? 'chase';
const morganSeeks = (process.argv[3] ?? 'seek') === 'seek';
const crewMode = process.argv[4] as 'two' | 'three' | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Json = any;

async function token(a: { email: string; password: string }) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...a, returnSecureToken: true }),
  });
  return ((await r.json()) as { idToken: string }).idToken;
}
async function call(t: string, method: string, path: string, body?: unknown, raw?: Buffer): Promise<Json> {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(raw ? { 'content-type': 'image/jpeg' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
const health = { permission: 'WHEN_IN_USE', preciseLocation: true, trackingActive: true, backgroundSessionActive: true, lowPowerMode: false, batteryLevel: 0.8, networkReachable: true, appVersion: 'fixture', queuedSamples: 0, lastFixAgeSeconds: 2, lastFixAccuracyMeters: 6 };

const morgan = await token(seed[0]!);
const taylor = await token(seed[1]!);
const casey = crewMode ? await token(seed[2]!) : null;

// Start clean: abort active rounds and close open nights for every account.
for (const t of [morgan, taylor, ...(casey ? [casey] : [])]) {
  for (const s of (await call(t, 'GET', '/v1/sessions?limit=50')).items ?? []) {
    if (s.status === 'COMPLETED') continue;
    const v = await call(t, 'GET', `/v1/sessions/${s.id}`);
    if (['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'].includes(v.round?.state)) await call(t, 'POST', `/v1/sessions/${s.id}/rounds/${v.round.id}/abort`, { reason: 'fixture reset', safety: false });
    await call(t, 'POST', `/v1/sessions/${s.id}/complete`, {});
  }
}

const me = await call(morgan, 'GET', '/v1/me');
const headStartSeconds = state === 'headstart' ? 600 : 60;
const created = await call(morgan, 'POST', '/v1/sessions', {
  title: 'Friday night',
  scheduledDate: new Date().toISOString().slice(0, 10),
  myTeam: 'A',
  teams: {
    A: { name: 'Night Owls', roster: [{ personId: me.profile.selfPersonId, displayName: me.profile.displayName }, { displayName: 'Casey' }, { displayName: 'Jordan' }] },
    B: { name: 'Foxes', roster: [{ displayName: 'Taylor' }, { displayName: 'Riley' }] },
    ...(crewMode === 'three' ? { C: { name: 'Ravens', roster: [{ displayName: 'Quinn' }] } } : {}),
  },
  firstHidingTeam: morganSeeks ? 'B' : 'A',
  seekMode: crewMode === 'three' ? 'RACE' : 'TOGETHER',
  rules: { headStartSeconds, pingIntervalSeconds: 60, visiblePingHistoryCount: 3, confirmationTimeoutSeconds: 300 },
});
const sid = created.sessionId as string;
const code = created.session.joinCode as string;
await call(taylor, 'POST', '/v1/invites/redeem', { code, teamKey: 'B' });
const consent = { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true };
await call(taylor, 'POST', `/v1/sessions/${sid}/consent`, consent);
await call(taylor, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
if (casey) {
  await call(casey, 'POST', '/v1/invites/redeem', { code, teamKey: crewMode === 'three' ? 'C' : 'A' });
  await call(casey, 'POST', `/v1/sessions/${sid}/consent`, consent);
  if (crewMode === 'three') await call(casey, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
}
if (state === 'lobby') { console.log(`lobby ready: session ${sid}`); process.exit(0); }
await call(morgan, 'POST', `/v1/sessions/${sid}/consent`, consent);

/** Plays one round from READY. Uploads both phones' GPS when `both` (the app isn't tracking). */
async function playRound(both: boolean, until: (rid: string, chaseAt: number) => Promise<boolean>) {
  await call(morgan, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
  await call(taylor, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
  if (crewMode === 'three') await call(casey!, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health });
  const rid = (await call(morgan, 'GET', `/v1/sessions/${sid}`)).round.id as string;
  await call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: true });
  const v = await call(taylor, 'GET', `/v1/sessions/${sid}`);
  const startAt = Date.parse(v.round.roundStartAt);
  const chaseAt = startAt + headStartSeconds * 1000;
  const taylorHides = v.round.hidingTeam === 'B';
  // Hiders walk a gentle curve through a park; seekers drive a grid after the head start.
  const walk = (s: number) => [39.7505 + s * 0.0000105, -104.9822 + Math.sin(s / 90) * 0.0012 + s * 0.000004];
  const drive = (s: number) => [39.7420 + Math.max(0, s - headStartSeconds) * 0.00006, -104.9905 + Math.max(0, s - headStartSeconds - 60) * 0.00005];
  for (;;) {
    const s = (Date.now() - startAt) / 1000;
    const mk = ([lat, lon]: number[]) => ({ batchId: randomUUID(), sentAt: new Date().toISOString(), samples: [{ pointId: randomUUID(), recordedAt: new Date(Date.now() - 700).toISOString(), latitude: lat, longitude: lon, horizontalAccuracyMeters: 6 }], health });
    await call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, mk(taylorHides ? walk(s) : drive(s)));
    if (both) await call(morgan, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, mk(taylorHides ? drive(s) : walk(s)));
    // Casey: Morgan's crew-mate (two) or a third crew that always seeks here (three).
    if (casey) await call(casey, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, mk(crewMode === 'two' && !taylorHides ? walk(s + 20) : drive(s + 30)));
    if (await until(rid, chaseAt)) return { rid, taylorHides };
    await sleep(4000);
  }
}

async function claimAndDecide(rid: string, taylorHides: boolean, decide: boolean) {
  const seeker = taylorHides ? morgan : taylor;
  const hider = taylorHides ? taylor : morgan;
  const init = await call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
  const jpeg = readFileSync(new URL('../tests/fixtures/catch.jpg', import.meta.url));
  await call(seeker, 'PUT', init.uploadPath, undefined, jpeg);
  await call(seeker, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.claimId });
  if (decide) await call(hider, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.claimId}/decision`, { decision: 'CONFIRM' });
}

const live = ['headstart', 'chase', 'pending', 'paused'].includes(state);
const afterPings = (n: number) => async (_rid: string, chaseAt: number) => Date.now() > chaseAt + (n - 1) * 60_000 + 5_000;
if (state === 'headstart') {
  await playRound(false, async () => true);
} else if (state === 'night') {
  for (let i = 0; i < 2; i++) {
    const { rid, taylorHides } = await playRound(true, afterPings(i === 0 ? 2 : 1));
    await claimAndDecide(rid, taylorHides, true);
    await sleep(1500);
    if (i === 0) await call(morgan, 'POST', `/v1/sessions/${sid}/next-round`, {});
  }
  await call(morgan, 'POST', `/v1/sessions/${sid}/complete`, {});
} else if (state === 'chase') {
  // Keep the hiding phone "healthy" and pings flowing while the app is reviewed.
  let announced = false;
  await playRound(false, async (_rid, chaseAt) => {
    if (!announced && Date.now() > chaseAt + 65_000) { announced = true; console.log(`chase ready: session ${sid} — Ctrl+C to stop`); }
    return false;
  });
} else {
  const { rid, taylorHides } = await playRound(!live, afterPings(state === 'recap' ? 3 : 2));
  if (state === 'pending') await claimAndDecide(rid, taylorHides, false);
  if (state === 'recap') await claimAndDecide(rid, taylorHides, true);
  if (state === 'paused') await call(taylor, 'POST', `/v1/sessions/${sid}/rounds/${rid}/pause`, { kind: 'SAFETY', reason: 'Crossing a busy road' });
}
console.log(`${state} ready: session ${sid}`);
