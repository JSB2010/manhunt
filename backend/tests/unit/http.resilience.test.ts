import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApiApp } from '../../src/api/app.js';
import { bucketFor, installErrorHandling, isTransientVerifyError, RateLimiter, rateLimited } from '../../src/api/http.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/observability/logger.js';
import { RecordingLiveActivityTransport } from '../../src/services/liveActivities.js';
import { RecordingNotifier } from '../../src/services/notifier.js';
import type { Deps } from '../../src/services/repo.js';
import { ManualScheduler } from '../../src/services/scheduler.js';
import { MemoryObjectStore } from '../../src/services/storage.js';

/**
 * Transport behaviour the app depends on to back off instead of storming or
 * signing people out: Retry-After on every 429, polling reads outside the
 * default bucket, and 503 (not 401) when the token can't be checked right now.
 */
const NOW = Date.UTC(2026, 9, 18);

function deps(): Deps {
  process.env.APP_ENV = 'test';
  const cfg = loadConfig({ env: 'test', scheduler: 'manual', notifier: 'log', projectId: 'demo-manhunt' });
  // No Firestore: every request here is answered before the handler touches it.
  return { cfg, db: {} as never, store: new MemoryObjectStore(), scheduler: new ManualScheduler(), notifier: new RecordingNotifier(), liveActivityTransport: new RecordingLiveActivityTransport(), clock: { now: () => NOW }, log: createLogger(cfg, 'http-resilience') };
}

/** firebase-admin's FirebaseAuthError shape. */
const authError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('rate limiter', () => {
  it('reports how long until the next token instead of a bare refusal', () => {
    const l = new RateLimiter();
    for (let i = 0; i < 10; i++) expect(l.take('u1', 'account', NOW)).toBe(0);
    // account: 10 per hour → one token every 6 minutes.
    expect(l.take('u1', 'account', NOW)).toBe(360_000);
    expect(l.take('u1', 'account', NOW + 300_000)).toBeCloseTo(60_000, -1);
    expect(l.take('u1', 'account', NOW + 361_000)).toBe(0);
    // Buckets are per uid.
    expect(l.take('u2', 'account', NOW)).toBe(0);
  });

  it('keeps the open-night poll out of the default bucket', () => {
    expect(bucketFor('GET', '/v1/sessions/:id', undefined)).toBe('poll');
    expect(bucketFor('DELETE', '/v1/sessions/:id', 'account')).toBe('account');
    expect(bucketFor('GET', '/v1/sessions', undefined)).toBe('default');
    expect(bucketFor('POST', '/v1/sessions/:id/ready', undefined)).toBe('default');

    const l = new RateLimiter();
    while (l.take('u1', 'default', NOW) === 0);
    expect(l.take('u1', 'default', NOW)).toBeGreaterThan(0);
    expect(l.take('u1', 'poll', NOW)).toBe(0);
  });

  it('every 429 carries Retry-After (seconds, at least 1) and the same value in details', async () => {
    const app = Fastify();
    installErrorHandling(app, deps());
    app.get('/limited', async () => {
      throw rateLimited(1_200);
    });
    app.get('/legacy', async () => {
      const { AppError } = await import('../../src/domain/errors.js');
      throw new AppError('RATE_LIMITED', 'Too many claims this round');
    });
    const a = await app.inject({ method: 'GET', url: '/limited' });
    expect(a.statusCode).toBe(429);
    expect(a.headers['retry-after']).toBe('2');
    expect(a.json().error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 2 } });
    expect(rateLimited(5).details).toEqual({ retryAfterSeconds: 1 });
    const b = await app.inject({ method: 'GET', url: '/legacy' });
    expect(b.statusCode).toBe(429);
    expect(Number(b.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('token verification failures', () => {
  it('classifies key-fetch and network failures as transient, token problems as definitive', () => {
    expect(isTransientVerifyError(authError('auth/argument-error', 'Error fetching public keys for Google certs: <html>502</html>'))).toBe(true);
    expect(isTransientVerifyError(authError('auth/argument-error', 'Error while making request: socket hang up. Error code: ECONNRESET'))).toBe(true);
    expect(isTransientVerifyError(authError('auth/internal-error', 'boom'))).toBe(true);
    expect(isTransientVerifyError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientVerifyError(authError('app/network-timeout', 'Error while making request: timeout of 10000ms exceeded.'))).toBe(true);

    expect(isTransientVerifyError(authError('auth/id-token-expired', 'Firebase ID token has expired.'))).toBe(false);
    expect(isTransientVerifyError(authError('auth/id-token-revoked', 'revoked'))).toBe(false);
    expect(isTransientVerifyError(authError('auth/argument-error', 'Firebase ID token has invalid signature.'))).toBe(false);
    expect(isTransientVerifyError(authError('auth/argument-error', 'Decoding Firebase ID token failed.'))).toBe(false);
    expect(isTransientVerifyError(authError('auth/user-disabled', 'disabled'))).toBe(false);
    expect(isTransientVerifyError(new Error('invalid'))).toBe(false);
  });

  it('answers 503 RETRYABLE_TEMPORARY when Google keys are unreachable and 401 for a bad token', async () => {
    let failure: Error = authError('auth/argument-error', 'Error fetching public keys for Google certs: unavailable');
    const app = await buildApiApp(deps(), {
      verifyIdToken: async () => {
        throw failure;
      },
    });
    const call = () => app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer t' } });

    const transient = await call();
    expect(transient.statusCode).toBe(503);
    expect(transient.json().error.code).toBe('RETRYABLE_TEMPORARY');

    failure = authError('auth/id-token-expired', 'Firebase ID token has expired.');
    const expired = await call();
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('UNAUTHENTICATED');

    const missing = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(missing.statusCode).toBe(401);
  });

  it('/v1/time needs no token and is never rate limited', async () => {
    const app = await buildApiApp(deps(), {
      verifyIdToken: async () => {
        throw new Error('must not be called');
      },
    });
    for (let i = 0; i < 400; i++) {
      const r = await app.inject({ method: 'GET', url: '/v1/time' });
      expect(r.statusCode).toBe(200);
    }
  });
});
