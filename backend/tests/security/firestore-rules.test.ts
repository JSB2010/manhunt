import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';

/**
 * Firestore security rules (spec §10.2, §11.3): a client can read exactly one
 * document type — its own sanitized view, while an active member — and can
 * write nothing. Raw points, rounds, pings, captures, summaries, routes,
 * members, invites and other users' views are unreachable even by guessing paths.
 */
let env: RulesTestEnvironment;
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085').split(':');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-manhunt',
    firestore: { rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'), host: host!, port: Number(port) },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'sessions/s1'), { hostUid: 'seeker', memberUids: ['seeker', 'hider'] });
    await setDoc(doc(db, 'sessions/s1/members/seeker'), { active: true, teamKey: 'B' });
    await setDoc(doc(db, 'sessions/s1/members/hider'), { active: true, teamKey: 'A' });
    await setDoc(doc(db, 'sessions/s1/members/kicked'), { active: false, teamKey: 'B' });
    await setDoc(doc(db, 'sessions/s1/views/seeker'), { uid: 'seeker', round: { pins: [] } });
    await setDoc(doc(db, 'sessions/s1/views/hider'), { uid: 'hider', round: { captureRequest: null } });
    await setDoc(doc(db, 'sessions/s1/views/kicked'), { uid: 'kicked' });
    await setDoc(doc(db, 'sessions/s1/rounds/r1'), { hiderUid: 'hider', pings: [{ latitude: 39.7, longitude: -104.9 }] });
    await setDoc(doc(db, 'sessions/s1/rounds/r1/points/p1'), { operatorUid: 'hider', latitude: 39.75, longitude: -104.98 });
    await setDoc(doc(db, 'sessions/s1/rounds/r1/pings/p0'), { latitude: 39.7 });
    await setDoc(doc(db, 'sessions/s1/rounds/r1/captures/c1'), { imageObjectKey: 'x' });
    await setDoc(doc(db, 'sessions/s1/roundSummaries/r1'), { pings: [] });
    await setDoc(doc(db, 'sessions/s1/routes/r1'), { teams: {} });
    await setDoc(doc(db, 'sessions/s1/events/e1'), { type: 'PING_RELEASED' });
    await setDoc(doc(db, 'users/hider'), { displayName: 'H' });
    await setDoc(doc(db, 'invites/i1'), { codeHash: 'abc' });
    await setDoc(doc(db, 'sessions/s1/liveActivities/seeker_device1'), { uid: 'seeker', roundId: 'r1', pushToken: 'abcdef0123456789' });
    await setDoc(doc(db, 'sessions/s1/liveActivities/hider_device1'), { uid: 'hider', roundId: 'r1', pushToken: 'abcdef0123456789' });
    await setDoc(doc(db, 'users/hider/devices/device1'), { fcmToken: 'x', liveActivityStartToken: 'abcdef0123456789' });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe('firestore.rules', () => {
  it('an active member can read only their own view', async () => {
    const seeker = env.authenticatedContext('seeker').firestore();
    await assertSucceeds(getDoc(doc(seeker, 'sessions/s1/views/seeker')));
    await assertFails(getDoc(doc(seeker, 'sessions/s1/views/hider')));
    await assertFails(getDocs(collection(seeker, 'sessions/s1/views')));
  });

  it('the seeker (and host) cannot read any raw or authoritative game data', async () => {
    const seeker = env.authenticatedContext('seeker').firestore();
    for (const p of [
      'sessions/s1',
      'sessions/s1/members/hider',
      'sessions/s1/rounds/r1',
      'sessions/s1/rounds/r1/points/p1',
      'sessions/s1/rounds/r1/pings/p0',
      'sessions/s1/rounds/r1/captures/c1',
      'sessions/s1/roundSummaries/r1',
      'sessions/s1/routes/r1',
      'sessions/s1/events/e1',
      // Live Activity push tokens (own and others')
      'sessions/s1/liveActivities/seeker_device1',
      'sessions/s1/liveActivities/hider_device1',
      'users/hider/devices/device1',
      'users/hider',
      'invites/i1',
    ]) {
      await assertFails(getDoc(doc(seeker, p)));
    }
    await assertFails(getDocs(collection(seeker, 'sessions/s1/rounds/r1/points')));
    await assertFails(getDocs(collection(seeker, 'sessions/s1/liveActivities')));
  });

  it('removed members and anonymous clients are denied', async () => {
    await assertFails(getDoc(doc(env.authenticatedContext('kicked').firestore(), 'sessions/s1/views/kicked')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'sessions/s1/views/seeker')));
    await assertFails(getDoc(doc(env.authenticatedContext('stranger').firestore(), 'sessions/s1/views/seeker')));
  });

  it('clients cannot write anything, including their own view or points', async () => {
    const hider = env.authenticatedContext('hider').firestore();
    await assertFails(updateDoc(doc(hider, 'sessions/s1/views/hider'), { round: { pins: [] } }));
    await assertFails(setDoc(doc(hider, 'sessions/s1/rounds/r1/points/p2'), { latitude: 1 }));
    await assertFails(setDoc(doc(hider, 'sessions/s1/members/hider'), { active: true, teamKey: 'B' }));
    await assertFails(setDoc(doc(hider, 'users/hider'), { displayName: 'x' }));
    await assertFails(setDoc(doc(hider, 'sessions/s1/liveActivities/hider_device1'), { pushToken: 'ab', roundId: 'r1' }));
  });
});
