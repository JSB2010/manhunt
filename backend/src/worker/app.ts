import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { parse } from '../schemas/api.js';
import { DataService } from '../services/dataService.js';
import { GameService } from '../services/gameService.js';
import type { Deps } from '../services/repo.js';
import { installErrorHandling } from '../api/http.js';
import { TickBody } from './jobs.js';

export interface WorkerAuthOptions {
  /** shared secret from `Config.devWorkerSecret`; null refuses every call */
  devSecret: string | null;
}

/**
 * Local worker for the dev stack (`src/dev.ts`) and tests: the HTTP twin of
 * the deployed `tick`, `watchdog` and `retention` functions (src/functions).
 * It is never deployed. Bound to 127.0.0.1 and gated by a shared secret, so
 * Firebase client ID tokens and anonymous calls are refused.
 */
export async function buildWorkerApp(deps: Deps, auth: WorkerAuthOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log, bodyLimit: 64_000 });
  const game = new GameService(deps);
  const data = new DataService(deps);

  app.addHook('onRequest', async (req) => {
    if (req.url === '/healthz') return;
    const secret = req.headers['x-worker-secret'];
    if (auth.devSecret && typeof secret === 'string') {
      const a = Buffer.from(secret);
      const b = Buffer.from(auth.devSecret);
      if (a.length === b.length && timingSafeEqual(a, b)) return;
    }
    if (!req.headers.authorization) throw new AppError('UNAUTHENTICATED', 'Worker requires the local worker secret');
    throw new AppError('FORBIDDEN', 'Caller is not an authorized worker invoker');
  });
  installErrorHandling(app, deps);

  app.get('/healthz', async () => ({ ok: true }));

  const tick = async (body: unknown) => {
    const b = parse(TickBody, body);
    const processed = await game.tick(b.sessionId, b.roundId);
    return { ok: true, processed };
  };
  // Spec §10.1 names; all are the same idempotent "advance due events" operation.
  app.post('/internal/rounds/tick', async (req) => tick(req.body));
  app.post('/internal/pings/fire', async (req) => tick(req.body));
  app.post('/internal/capture/expire', async (req) => tick(req.body));
  app.post('/internal/round/timeout', async (req) => tick(req.body));
  app.post('/internal/watchdog/repair', async () => game.watchdog());
  app.post('/internal/retention/sweep', async () => data.retentionSweep());
  return app;
}
