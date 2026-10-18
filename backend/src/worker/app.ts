import Fastify, { type FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { parse } from '../schemas/api.js';
import { DataService } from '../services/dataService.js';
import { GameService } from '../services/gameService.js';
import type { Deps } from '../services/repo.js';
import { installErrorHandling } from '../api/http.js';

export interface WorkerAuthOptions {
  /** service accounts allowed to invoke the worker (Cloud Tasks invoker, Cloud Scheduler) */
  allowedInvokers: string[];
  audience: string;
  /** dev-only shared secret; null in production */
  devSecret: string | null;
  verifyOidc?: (token: string) => Promise<{ email?: string | undefined; iss?: string | undefined } | null>;
}

const TickBody = z
  .object({ sessionId: z.string().min(1).max(128), roundId: z.string().min(1).max(128), generation: z.number().int().optional(), eventKey: z.string().max(64).optional(), at: z.number().optional() })
  .strict();

/**
 * Private worker (Cloud Run, ingress internal + IAM `run.invoker` only for the
 * task/scheduler service accounts). Defense in depth: the app also verifies
 * the Google-signed OIDC token and its invoker email. Firebase client ID tokens
 * (issuer securetoken.google.com) are never accepted here.
 */
export async function buildWorkerApp(deps: Deps, auth: WorkerAuthOptions): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.log, bodyLimit: 64_000 });
  const game = new GameService(deps);
  const data = new DataService(deps);
  const oauth = new OAuth2Client();
  const verifyOidc =
    auth.verifyOidc ??
    (async (token: string) => {
      const ticket = await oauth.verifyIdToken({ idToken: token, audience: auth.audience });
      const p = ticket.getPayload();
      return p ? { email: p.email, iss: p.iss } : null;
    });

  app.addHook('onRequest', async (req) => {
    if (req.url === '/healthz') return;
    const secret = req.headers['x-worker-secret'];
    if (auth.devSecret && typeof secret === 'string') {
      const a = Buffer.from(secret);
      const b = Buffer.from(auth.devSecret);
      if (a.length === b.length && timingSafeEqual(a, b)) return;
    }
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Worker requires an OIDC token');
    let payload: { email?: string | undefined; iss?: string | undefined } | null = null;
    try {
      payload = await verifyOidc(header.slice(7));
    } catch {
      payload = null;
    }
    const issuerOk = payload?.iss === 'https://accounts.google.com' || payload?.iss === 'accounts.google.com';
    if (!payload || !issuerOk || !payload.email || !auth.allowedInvokers.includes(payload.email)) {
      throw new AppError('FORBIDDEN', 'Caller is not an authorized worker invoker');
    }
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
