import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApiApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/observability/logger.js';
import { firebase } from '../../src/services/firebase.js';
import { RecordingNotifier } from '../../src/services/notifier.js';
import type { Deps } from '../../src/services/repo.js';
import { ManualScheduler } from '../../src/services/scheduler.js';
import { GcsObjectStore } from '../../src/services/storage.js';
import { buildWorkerApp } from '../../src/worker/app.js';

export const PROJECT = 'demo-manhunt';
process.env.GOOGLE_CLOUD_PROJECT ??= PROJECT;
process.env.APP_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
process.env.STORAGE_EMULATOR_HOST ??= `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;

export class FakeClock {
  t = Date.UTC(2026, 9, 17, 20, 0, 0);
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(ms: number) {
    this.t = ms;
  }
}

export const MIN = 60_000;
export const WORKER_SECRET = 'test-worker-secret';

export interface TestUser {
  uid: string;
  token: string;
  name: string;
  email: string;
}

export interface Harness {
  api: FastifyInstance;
  worker: FastifyInstance;
  clock: FakeClock;
  scheduler: ManualScheduler;
  notifier: RecordingNotifier;
  deps: Deps;
  createUser(name: string): Promise<TestUser>;
  call<T = any>(user: TestUser | null, method: InjectOptions['method'], url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T; headers: Record<string, unknown>; raw: Buffer }>;
  tick(sid: string, rid: string): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function clearEmulators() {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await fetch(`http://${fsHost}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${authHost}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

export async function harness(): Promise<Harness> {
  const clock = new FakeClock();
  const cfg = loadConfig({ env: 'test', scheduler: 'manual', notifier: 'log', bucket: `${PROJECT}.appspot.com`, devWorkerSecret: WORKER_SECRET });
  const log = createLogger(cfg, 'test');
  const fb = firebase(cfg);
  const scheduler = new ManualScheduler();
  const notifier = new RecordingNotifier();
  const deps: Deps = {
    cfg,
    db: fb.db,
    store: new GcsObjectStore(fb.bucket),
    scheduler,
    notifier,
    clock,
    log,
    deleteAuthUser: (uid) => fb.auth.deleteUser(uid).then(() => undefined),
  };
  const api = await buildApiApp(deps, { verifyIdToken: (t) => fb.auth.verifyIdToken(t) });
  const worker = await buildWorkerApp(deps, { devSecret: WORKER_SECRET });
  await api.ready();
  await worker.ready();

  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const createUser = async (name: string): Promise<TestUser> => {
    const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
    const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', displayName: name, returnSecureToken: true }),
    });
    const j = (await res.json()) as { localId: string; idToken: string };
    // Set displayName on the token by updating the profile, then sign in again.
    await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:update?key=demo-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: j.idToken, displayName: name, returnSecureToken: true }),
    });
    const signIn = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123', returnSecureToken: true }),
    });
    const s = (await signIn.json()) as { localId: string; idToken: string };
    return { uid: s.localId, token: s.idToken, name, email };
  };

  const call: Harness['call'] = async (user, method, url, body, headers = {}) => {
    const isBuffer = Buffer.isBuffer(body);
    const res = await api.inject({
      method,
      url,
      headers: {
        ...(user ? { authorization: `Bearer ${user.token}` } : {}),
        ...(body !== undefined && !isBuffer ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: isBuffer ? (body as Buffer) : JSON.stringify(body) } : {}),
    });
    let parsed: any = res.body;
    if ((res.headers['content-type'] ?? '').toString().includes('json')) parsed = JSON.parse(res.body);
    return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown>, raw: res.rawPayload };
  };

  const tick = async (sid: string, rid: string) => {
    const res = await worker.inject({ method: 'POST', url: '/internal/rounds/tick', headers: { 'x-worker-secret': WORKER_SECRET, 'content-type': 'application/json' }, payload: JSON.stringify({ sessionId: sid, roundId: rid }) });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  return {
    api,
    worker,
    clock,
    scheduler,
    notifier,
    deps,
    createUser,
    call,
    tick,
    close: async () => {
      await api.close();
      await worker.close();
    },
  };
}

export const healthyPreflight = (over: Record<string, unknown> = {}) => ({
  permission: 'WHEN_IN_USE',
  preciseLocation: true,
  trackingActive: true,
  backgroundSessionActive: true,
  lowPowerMode: false,
  batteryLevel: 0.9,
  networkReachable: true,
  appVersion: '0.1.0',
  queuedSamples: 0,
  lastFixAgeSeconds: 3,
  lastFixAccuracyMeters: 6,
  ...over,
});

export const consentBody = { accepted: true, consentVersion: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true };

/** Minimal structurally valid JPEG with EXIF (incl. fake GPS) and a comment segment. */
export function jpegWithExif(): Buffer {
  const seg = (marker: number, payload: Buffer) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  const app0 = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  const app1 = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude=39.739236;GPSLongitude=-104.990251')]));
  const com = seg(0xfe, Buffer.from('device-serial-12345'));
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sof = seg(0xc0, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00]));
  const dht = seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])]));
  const sos = seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, dqt, sof, dht, sos, Buffer.from([0xd2, 0xcf, 0x20, 0xa5]), Buffer.from([0xff, 0xd9])]);
}

/** Build a location batch. `points` are [recordedAtMs, lat, lon, accuracy?]. Device clock == server clock unless skewMs given. */
export function batch(clock: FakeClock, points: [number, number, number, number?][], skewMs = 0) {
  return {
    batchId: randomUUID(),
    sentAt: new Date(clock.now() - skewMs).toISOString(),
    samples: points.map(([t, lat, lon, acc]) => ({
      pointId: randomUUID(),
      recordedAt: new Date(t - skewMs).toISOString(),
      latitude: lat,
      longitude: lon,
      horizontalAccuracyMeters: acc ?? 6,
      speedMetersPerSecond: 1.4,
      courseDegrees: 90,
    })),
    health: healthyPreflight(),
  };
}
