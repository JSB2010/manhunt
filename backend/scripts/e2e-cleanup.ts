/**
 * Local E2E hygiene: abort any active rounds and close open nights for the
 * emulator demo accounts so a new two-simulator run starts from Home.
 * Emulator/demo project only.
 */
import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
if (!(process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-manhunt').startsWith('demo-')) throw new Error('demo projects only');
const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')).accounts as { email: string; password: string }[];

async function token(a: { email: string; password: string }) {
  const r = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...a, returnSecureToken: true }),
  });
  return ((await r.json()) as { idToken: string }).idToken;
}
const call = async (t: string, m: string, p: string, b?: unknown) =>
  (await fetch(API + p, { method: m, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json() as Promise<any>;

let aborted = 0, closed = 0;
for (const a of seed.slice(0, 2)) {
  const t = await token(a);
  const list = await call(t, 'GET', '/v1/sessions?limit=50');
  for (const s of list.items ?? []) {
    if (s.status === 'COMPLETED') continue;
    const v = await call(t, 'GET', `/v1/sessions/${s.id}`);
    if (['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'].includes(v.round?.state)) {
      await call(t, 'POST', `/v1/sessions/${s.id}/rounds/${v.round.id}/abort`, { reason: 'E2E cleanup', safety: false });
      aborted++;
    }
    // Any phone in the night can end it.
    const r = await call(t, 'POST', `/v1/sessions/${s.id}/complete`, {});
    if (r.ok) closed++;
  }
}
console.log(`e2e cleanup: aborted ${aborted} active rounds, closed ${closed} open nights`);
