import Fastify, { type FastifyInstance } from 'fastify';
import type { Auth } from 'firebase-admin/auth';
import { randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { DataService } from '../services/dataService.js';
import { GameService } from '../services/gameService.js';
import type { Deps } from '../services/repo.js';
import { SocialService } from '../services/socialService.js';
import { bucketFor, FAILURE_ONLY_BUCKETS, installErrorHandling, installGzipBodies, installIdempotency, installServerTime, isTransientVerifyError, RateLimiter, rateLimited } from './http.js';
import { registerDataRoutes } from './routes/data.js';
import { registerGameRoutes } from './routes/game.js';
import { registerMeRoutes } from './routes/me.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSocialRoutes } from './routes/social.js';

declare module 'fastify' {
  interface FastifyInstance {
    registeredRoutes: { method: string; url: string }[];
  }
}

export interface Services {
  game: GameService;
  social: SocialService;
  data: DataService;
}

export interface ApiOptions {
  verifyIdToken: Auth['verifyIdToken'];
}

/**
 * Public API (the `api` Cloud Function, public invoker). Every route except /healthz and
 * /v1/time requires a Firebase ID token. Never exposes /internal routes.
 */
export async function buildApiApp(deps: Deps, opts: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
    bodyLimit: 1_000_000,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    },
  });
  const registered: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') registered.push({ method: m, url: r.url });
  });
  app.decorate('registeredRoutes', registered);
  const services: Services = { game: new GameService(deps), social: new SocialService(deps), data: new DataService(deps) };
  const limiter = new RateLimiter();

  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: deps.cfg.maxPhotoBytes + 1024 }, (_req, body, done) => done(null, body));
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
    try {
      const decoded = await opts.verifyIdToken(header.slice(7));
      req.auth = { uid: decoded.uid, email: decoded.email, name: decoded.name as string | undefined };
    } catch (err) {
      if (isTransientVerifyError(err)) {
        req.log.warn({ err }, 'token verification unavailable');
        throw new AppError('RETRYABLE_TEMPORARY', 'Sign-in check temporarily unavailable, please retry');
      }
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired token');
    }
    const bucket = bucketFor(req.method, req.routeOptions.url, req.routeOptions.config?.rateLimit);
    const now = deps.clock.now();
    // Failure-only buckets (code guessing) are charged in onResponse; the request itself counts as default traffic.
    const waitMs = FAILURE_ONLY_BUCKETS.has(bucket)
      ? limiter.peek(req.auth.uid, bucket, now) || limiter.take(req.auth.uid, 'default', now)
      : limiter.take(req.auth.uid, bucket, now);
    if (waitMs > 0) throw rateLimited(waitMs);
    await services.social.ensureUser(req.auth.uid, { email: req.auth.email, name: req.auth.name });
  });

  app.addHook('onResponse', async (req, reply) => {
    const bucket = req.routeOptions.config?.rateLimit;
    if (req.auth && bucket && FAILURE_ONLY_BUCKETS.has(bucket) && reply.statusCode >= 400 && reply.statusCode < 500 && reply.statusCode !== 429) {
      limiter.take(req.auth.uid, bucket, deps.clock.now());
    }
  });

  installErrorHandling(app, deps);
  installGzipBodies(app);
  installServerTime(app, deps);
  installIdempotency(app, deps);

  app.get('/healthz', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/v1/time', { config: { public: true } }, async () => ({ serverTime: new Date(deps.clock.now()).toISOString() }));

  registerMeRoutes(app, services);
  registerSocialRoutes(app, services);
  registerSessionRoutes(app, services);
  registerGameRoutes(app, services);
  registerDataRoutes(app, services);
  return app;
}

export const uidOf = (req: { auth: { uid: string } | null }) => {
  if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Not signed in');
  return req.auth.uid;
};
