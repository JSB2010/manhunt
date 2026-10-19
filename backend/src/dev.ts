/**
 * Local development runner: public API (8787) + private worker (8788) against
 * the Firebase Emulator Suite, with an in-process scheduler standing in for the
 * task queue and a watchdog interval standing in for the scheduled functions.
 * Refuses to run without emulators. (`npm run serve:functions` runs the real
 * Cloud Functions entry points in the Functions + Cloud Tasks emulators.)
 */
import { buildApiApp } from './api/app.js';
import { buildDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { firebase } from './services/firebase.js';
import { GameService } from './services/gameService.js';
import { DataService } from './services/dataService.js';
import { buildWorkerApp } from './worker/app.js';

process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
process.env.STORAGE_EMULATOR_HOST ??= 'http://127.0.0.1:9199';
process.env.GOOGLE_CLOUD_PROJECT ??= 'demo-manhunt';

const apiPort = Number(process.env.API_PORT ?? 8787);
const workerPort = Number(process.env.WORKER_PORT ?? 8788);
const cfg = loadConfig({ port: apiPort, workerUrl: `http://127.0.0.1:${workerPort}`, scheduler: 'local', notifier: 'log', bucket: process.env.MEDIA_BUCKET ?? 'demo-manhunt.appspot.com' });
if (!cfg.usingEmulators) throw new Error('dev runner requires the Firebase emulators');
const log = createLogger(cfg, 'manhunt-dev');
const deps = buildDeps(cfg, log);
const fb = firebase(cfg);

const api = await buildApiApp(deps, { verifyIdToken: (t) => fb.auth.verifyIdToken(t) });
const worker = await buildWorkerApp(deps, { devSecret: cfg.devWorkerSecret });
const host = process.env.API_HOST ?? '0.0.0.0';
await api.listen({ host, port: apiPort });
await worker.listen({ host: '127.0.0.1', port: workerPort });
log.info({ api: `http://${host}:${apiPort}`, worker: `http://127.0.0.1:${workerPort}` }, 'manhunt dev stack up (emulators)');

const game = new GameService(deps);
const data = new DataService(deps);
const watchdog = setInterval(() => game.watchdog().catch((err) => log.error({ err }, 'watchdog failed')), cfg.watchdogIntervalMs);
const retention = setInterval(() => data.retentionSweep().catch((err) => log.error({ err }, 'retention failed')), 3600_000);
// Repair any rounds that were active when the dev server last stopped.
game.watchdog().catch(() => undefined);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    clearInterval(watchdog);
    clearInterval(retention);
    deps.scheduler.close?.();
    await Promise.all([api.close(), worker.close()]);
    process.exit(0);
  });
}
