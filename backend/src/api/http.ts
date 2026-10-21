import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';
import { paths, type Deps } from '../services/repo.js';

export interface AuthContext {
  uid: string;
  email?: string | undefined;
  name?: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    idempotencyDocId?: string;
  }
  interface FastifyContextConfig {
    rateLimit?: RateBucket;
    public?: boolean;
  }
}

export type RateBucket = 'default' | 'poll' | 'location' | 'capture' | 'invite' | 'join' | 'friend' | 'export' | 'account';

const LIMITS: Record<RateBucket, { capacity: number; perMs: number }> = {
  default: { capacity: 300, perMs: 60_000 },
  poll: { capacity: 240, perMs: 60_000 },
  location: { capacity: 60, perMs: 60_000 },
  capture: { capacity: 20, perMs: 60_000 },
  invite: { capacity: 20, perMs: 3_600_000 },
  /** failed night-code lookups only (see FAILURE_ONLY_BUCKETS) */
  join: { capacity: 12, perMs: 3_600_000 },
  friend: { capacity: 30, perMs: 3_600_000 },
  export: { capacity: 30, perMs: 3_600_000 },
  account: { capacity: 10, perMs: 3_600_000 },
};

/**
 * Cheap reads the app repeats on a timer (the open night's view, reconciled every
 * 10 s next to the Firestore listener). They get their own bucket so polling can
 * never starve writes in `default`. Keyed by Fastify route pattern.
 */
const ROUTE_BUCKETS: Record<string, RateBucket> = {
  'GET /v1/sessions/:id': 'poll',
};

export function bucketFor(method: string, routeUrl: string | undefined, configured: RateBucket | undefined): RateBucket {
  return configured ?? ROUTE_BUCKETS[`${method} ${routeUrl}`] ?? 'default';
}

/** Buckets charged only when the request fails (brute-force guards); successes are free. */
export const FAILURE_ONLY_BUCKETS: ReadonlySet<RateBucket> = new Set(['join']);

/**
 * Per-instance token bucket keyed by uid+bucket. The `api` function may run several
 * instances, so effective limits scale with instance count — acceptable for a
 * friends-only app (documented in docs/permissions-threat-model.md).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  /** Like `take` without consuming: 0 when a token is available, else the ms until one is. */
  peek(key: string, bucket: RateBucket, now: number): number {
    const { capacity, perMs } = LIMITS[bucket];
    const b = this.buckets.get(`${bucket}:${key}`);
    const tokens = b ? Math.min(capacity, b.tokens + ((now - b.at) / perMs) * capacity) : capacity;
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * perMs) / capacity);
  }
  /** Takes one token; returns 0 when allowed, else the ms until the next token is available. */
  take(key: string, bucket: RateBucket, now: number): number {
    const { capacity, perMs } = LIMITS[bucket];
    const k = `${bucket}:${key}`;
    const b = this.buckets.get(k) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / perMs) * capacity);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(k, b);
      return Math.ceil(((1 - b.tokens) * perMs) / capacity);
    }
    b.tokens -= 1;
    this.buckets.set(k, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
    return 0;
  }
}

/** 429 with the wait the client should honour (sent as `Retry-After` and in `details`). */
export function rateLimited(retryAfterMs: number, message = 'Too many requests, slow down') {
  return new AppError('RATE_LIMITED', message, { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
}

/**
 * Whether a `verifyIdToken` failure says nothing about the token itself: the
 * Admin SDK couldn't fetch Google's signing keys (network, timeout, 5xx). It
 * reports those as `auth/argument-error` with the fetch error as the message, so
 * the message is what tells them apart. These are 503s — answering 401 would
 * make the app drop a perfectly good session.
 */
export function isTransientVerifyError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  // FirebaseAppError (app/network-error, app/network-timeout…) and Node socket errors.
  if (code === 'auth/internal-error' || code.startsWith('app/') || /^E[A-Z_]+$/.test(code)) return true;
  return /fetching public keys|while making request|network|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message);
}

export function errorBody(e: AppError, now: number, requestId: string) {
  return { error: { code: e.code, message: e.message, details: e.details ?? null }, requestId, serverTime: new Date(now).toISOString() };
}

export function installErrorHandling(app: FastifyInstance, deps: Deps) {
  app.setErrorHandler((err: unknown, req, reply) => {
    const now = deps.clock.now();
    if (err instanceof AppError) {
      if (err.code === 'RATE_LIMITED') {
        const s = err.details?.retryAfterSeconds;
        reply.header('retry-after', String(typeof s === 'number' && s > 0 ? Math.ceil(s) : 30));
      }
      return reply.status(err.status).send(errorBody(err, now, req.id));
    }
    const fe = err as { statusCode?: number; code?: string; validation?: unknown; message?: string };
    if (fe.validation || fe.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fe.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fe.statusCode === 400) {
      return reply.status(400).send(errorBody(new AppError('VALIDATION_FAILED', fe.message ?? 'Bad request'), now, req.id));
    }
    if (fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || fe.statusCode === 413) {
      return reply.status(413).send(errorBody(new AppError('PAYLOAD_TOO_LARGE', 'Request body too large'), now, req.id));
    }
    if (fe.statusCode === 415) {
      return reply.status(415).send(errorBody(new AppError('UNSUPPORTED_MEDIA', 'Unsupported content type'), now, req.id));
    }
    // Firestore contention / aborted transactions are retryable.
    const grpc = (err as { code?: number }).code;
    req.log.error({ err }, 'unhandled error');
    const retry = grpc === 10 || grpc === 14 || grpc === 4;
    return reply
      .status(retry ? 503 : 500)
      .send(errorBody(new AppError('RETRYABLE_TEMPORARY', retry ? 'Temporary contention, please retry' : 'Internal error'), now, req.id));
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send(errorBody(new AppError('NOT_FOUND', 'Route not found'), deps.clock.now(), req.id)));
}

/** Adds `serverTime` to every JSON object response and the X-Server-Time header to all responses. */
export function installServerTime(app: FastifyInstance, deps: Deps) {
  app.addHook('preSerialization', async (_req, _reply, payload) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Buffer.isBuffer(payload) && !('serverTime' in (payload as object))) {
      return { ...(payload as object), serverTime: new Date(deps.clock.now()).toISOString() };
    }
    return payload;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-server-time', new Date(deps.clock.now()).toISOString());
    reply.header('x-request-id', req.id);
    reply.header('cache-control', 'private, no-store');
    return payload;
  });
}

/**
 * Idempotency-Key support for state-changing calls (spec §10.3). Only successes
 * are remembered: a retried request after a 4xx (stale phase, rate limit, a
 * location batch rejected while the round was settling) must run again, not
 * replay the failure for the key's lifetime.
 */
export function installIdempotency(app: FastifyInstance, deps: Deps) {
  const p = paths(deps.db);
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string' || !req.auth || req.method === 'GET') return;
    if (!/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new AppError('VALIDATION_FAILED', 'Invalid Idempotency-Key');
    const id = createHash('sha256').update(`${req.auth.uid}:${req.method}:${req.routeOptions.url}:${req.url}:${key}`).digest('hex');
    req.idempotencyDocId = id;
    const snap = await p.idempotency(id).get();
    const d = snap.data();
    if (d && d.status >= 200 && d.status < 300) {
      reply.header('idempotent-replay', 'true');
      reply.status(d.status).type('application/json').send(d.body);
      return reply;
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.idempotencyDocId || reply.getHeader('idempotent-replay')) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== 'string' || payload.length > 200_000) return payload;
    await p
      .idempotency(req.idempotencyDocId)
      .set({ status: reply.statusCode, body: payload, createdAt: deps.clock.now(), expireAt: Timestamp.fromMillis(deps.clock.now() + 24 * 3600_000) })
      .catch((err) => req.log.warn({ err }, 'idempotency store failed'));
    return payload;
  });
}
