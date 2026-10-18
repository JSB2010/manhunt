/**
 * Seed demo accounts into the LOCAL Firebase Auth emulator and make them friends.
 * Refuses to run unless FIREBASE_AUTH_EMULATOR_HOST is set and the project id is demo-*.
 *   cd backend && npm run seed:emulator
 */
import { readFileSync } from 'node:fs';

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const project = process.env.GOOGLE_CLOUD_PROJECT ?? 'demo-manhunt';
const api = process.env.API_URL ?? 'http://127.0.0.1:8787';
if (!project.startsWith('demo-')) throw new Error('Refusing to seed a non-demo project');
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST && !authHost.startsWith('127.0.0.1')) throw new Error('Emulator only');

const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')) as {
  accounts: { email: string; password: string; displayName: string; handle: string }[];
};

async function idp(path: string, body: unknown) {
  const r = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/${path}?key=demo-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as { idToken?: string; localId?: string; error?: { message: string } };
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await r.json()) as any;
}

const tokens: Record<string, string> = {};
for (const a of seed.accounts) {
  let res = await idp('accounts:signInWithPassword', { email: a.email, password: a.password, returnSecureToken: true });
  if (!res.idToken) {
    res = await idp('accounts:signUp', { email: a.email, password: a.password, displayName: a.displayName, returnSecureToken: true });
    await idp('accounts:update', { idToken: res.idToken, displayName: a.displayName });
    res = await idp('accounts:signInWithPassword', { email: a.email, password: a.password, returnSecureToken: true });
  }
  tokens[a.handle] = res.idToken!;
  await call(res.idToken!, 'PATCH', '/v1/me', { displayName: a.displayName, handle: a.handle });
  console.log(`seeded ${a.email} (@${a.handle})`);
}
// Make everyone friends with the first account.
const [first, ...rest] = seed.accounts;
for (const a of rest) {
  await call(tokens[a.handle]!, 'POST', '/v1/friends/requests', { handle: first!.handle });
  const reqs = await call(tokens[first!.handle]!, 'GET', '/v1/friends/requests');
  for (const r of reqs.incoming ?? []) await call(tokens[first!.handle]!, 'POST', `/v1/friends/requests/${r.requestId}/respond`, { accept: true });
}
console.log('done — sign in on the simulators with the accounts in scripts/seed-accounts.json');
