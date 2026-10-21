/**
 * Diagnostic: does a Firestore client listener on sessions/{sid}/views/{uid}
 * keep receiving updates as the API mutates the session? (local emulators only)
 */
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot } from 'firebase/firestore';

const API = 'http://127.0.0.1:8787';
const seed = JSON.parse(readFileSync(new URL('./seed-accounts.json', import.meta.url), 'utf8')).accounts;
const app = initializeApp({ projectId: 'demo-manhunt', apiKey: 'demo-key', authDomain: 'localhost' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8085);
const cred = await signInWithEmailAndPassword(auth, seed[0].email, seed[0].password);
const hostTok = await cred.user.getIdToken();
const t2 = (await (await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: seed[1].email, password: seed[1].password, returnSecureToken: true }) })).json()) as { idToken: string };
const guestTok = t2.idToken as string;
const call = async (tok: string, m: string, p: string, b?: unknown) => (await fetch(API + p, { method: m, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json() as Promise<any>;
const health = { permission: 'WHEN_IN_USE', preciseLocation: true, trackingActive: false, backgroundSessionActive: false, lowPowerMode: false, networkReachable: true, queuedSamples: 0 };
const s = await call(hostTok, 'POST', '/v1/sessions', { title: 'probe', scheduledDate: '2026-10-18', myTeam: 'A', teams: { A: { name: 'A', roster: [] }, B: { name: 'B', roster: [] } } });
const sid = s.sessionId;
let n = 0;
const t0 = Date.now();
onSnapshot(doc(db, 'sessions', sid, 'views', cred.user.uid), { includeMetadataChanges: true }, (snap) => {
  n++;
  const v = snap.data() as any;
  console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s snapshot#${n} cache=${snap.metadata.fromCache} B.phones=${v?.session?.teams?.B?.operators?.length} consentA=${v?.session?.teams?.A?.operators?.[0]?.consentGiven} readyB=${v?.round?.ready?.B}`);
}, (e) => console.log('listener error', e.code, e.message));
const step = async (label: string, f: () => Promise<unknown>) => { await new Promise((r) => setTimeout(r, 3000)); console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s -> ${label}`); await f(); };
let code = '';
await step('invite', async () => { code = (await call(hostTok, 'POST', `/v1/sessions/${sid}/invites`, {})).code; });
await step('redeem', () => call(guestTok, 'POST', '/v1/invites/redeem', { code, teamKey: 'B' }));
await step('guest consent', () => call(guestTok, 'POST', `/v1/sessions/${sid}/consent`, { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true }));
await step('host consent', () => call(hostTok, 'POST', `/v1/sessions/${sid}/consent`, { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true }));
await step('guest ready', () => call(guestTok, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health }));
await step('guest ready heartbeat', () => call(guestTok, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: health }));
await new Promise((r) => setTimeout(r, 4000));
console.log(`total snapshots: ${n}`);
process.exit(0);
