/**
 * Cloud Functions for Firebase entry point (`firebase deploy --only functions`).
 *
 *   api        HTTPS, public: the Fastify API; every route but /healthz and
 *              /v1/time verifies a Firebase ID token in-app.
 *   tick       Task queue, private: deadline wake-ups (chase start, pings,
 *              claim expiry, time cap). Only the backend service account may
 *              enqueue or invoke it.
 *   watchdog   Scheduled every minute, private: repairs missed wake-ups.
 *   retention  Scheduled daily, private: deletes expired photos and tracks.
 *
 * Deploy-time discovery loads this module without runtime config, so nothing
 * here may touch Firebase or read APP_ENV at import time — see `runtime()`.
 */
import type { FastifyInstance } from 'fastify';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { buildApiApp } from '../api/app.js';
import { buildDeps } from '../bootstrap.js';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../observability/logger.js';
import { DataService } from '../services/dataService.js';
import { firebase } from '../services/firebase.js';
import { GameService } from '../services/gameService.js';
import type { Deps } from '../services/repo.js';
import { fastifyHandler } from './http.js';
import { runTickTask } from './tasks.js';

/** Every function, and the task queue, lives here. Keep it near the Firestore location. */
const REGION = 'us-central1';
/**
 * Least-privilege runtime identity, created once by scripts/setup-gcp-project.sh.
 * Spelled out in full when the project is known (the CLI sets GCLOUD_PROJECT
 * for discovery): firebase-tools passes the `name@` shorthand to Cloud
 * Scheduler unexpanded, which rejects it with 400 INVALID_ARGUMENT.
 */
const SERVICE_ACCOUNT_NAME = 'manhunt-backend';
const PROJECT_ID = process.env.GCLOUD_PROJECT;
const SERVICE_ACCOUNT = PROJECT_ID ? `${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com` : `${SERVICE_ACCOUNT_NAME}@`;
const TICK = 'tick';

// Asked on the first `firebase deploy` to a project, then saved in backend/.env.<project>.
defineString('APP_ENV', {
  description: 'Backend environment for this Firebase project',
  input: { select: { options: [{ label: 'dev (shared test backend)', value: 'dev' }, { label: 'prod (friends-only production)', value: 'prod' }] } },
});

setGlobalOptions({ region: REGION, serviceAccount: SERVICE_ACCOUNT });

interface Runtime {
  cfg: Config;
  deps: Deps;
  game: GameService;
  data: DataService;
}

const runtimes = new Map<string, Runtime>();

/** Built on first use in each instance; each function is its own Cloud Run service. */
function runtime(fn: string): Runtime {
  let rt = runtimes.get(fn);
  if (!rt) {
    const cfg = loadConfig({ scheduler: 'taskqueue', tasksLocation: REGION, tasksFunction: TICK });
    const deps = buildDeps(cfg, createLogger(cfg, `manhunt-${fn}`));
    rt = { cfg, deps, game: new GameService(deps), data: new DataService(deps) };
    runtimes.set(fn, rt);
  }
  return rt;
}

let apiApp: Promise<FastifyInstance> | undefined;
const getApiApp = () =>
  (apiApp ??= (async () => {
    const { cfg, deps } = runtime('api');
    const fb = firebase(cfg);
    const app = await buildApiApp(deps, { verifyIdToken: (t) => fb.auth.verifyIdToken(t) });
    await app.ready();
    return app;
  })().catch((err) => {
    apiApp = undefined;
    throw err;
  }));

// Scales to zero when idle; the ceiling only bounds a busy night (Cloud Run answers
// a plain 429 once every instance is saturated, which the app backs off from).
export const api = onRequest({ invoker: 'public', memory: '512MiB', concurrency: 40, maxInstances: 20, timeoutSeconds: 60 }, fastifyHandler(getApiApp));

export const tick = onTaskDispatched(
  {
    invoker: [SERVICE_ACCOUNT],
    retryConfig: { maxAttempts: 20, minBackoffSeconds: 1, maxBackoffSeconds: 30, maxDoublings: 4 },
    rateLimits: { maxConcurrentDispatches: 20, maxDispatchesPerSecond: 20 },
    memory: '512MiB',
    concurrency: 20,
    maxInstances: 3,
    timeoutSeconds: 90,
  },
  async (req) => {
    const { cfg, deps, game } = runtime(TICK);
    // The emulator delivers tasks without an OIDC token.
    const allowedCallers = process.env.FUNCTIONS_EMULATOR === 'true' ? null : [`${SERVICE_ACCOUNT_NAME}@${cfg.projectId}.iam.gserviceaccount.com`];
    await runTickTask(req, { game, allowedCallers, log: deps.log, now: () => deps.clock.now() });
  },
);

export const watchdog = onSchedule({ schedule: '* * * * *', timeZone: 'Etc/UTC', retryCount: 1, maxInstances: 1, timeoutSeconds: 120 }, async () => {
  await runtime('watchdog').game.watchdog();
});

export const retention = onSchedule({ schedule: '17 4 * * *', timeZone: 'Etc/UTC', maxInstances: 1, timeoutSeconds: 540 }, async () => {
  await runtime('retention').data.retentionSweep();
});
