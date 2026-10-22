import Fastify from 'fastify';
import type { OutgoingHttpHeader } from 'node:http';
import { describe, expect, it } from 'vitest';
import { buildApiApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config.js';
import { fastifyHandler, stripFunctionPrefix, type FnRequest } from '../../src/functions/http.js';
import { createLogger } from '../../src/observability/logger.js';
import { RecordingLiveActivityTransport } from '../../src/services/liveActivities.js';
import { RecordingNotifier } from '../../src/services/notifier.js';
import type { Deps } from '../../src/services/repo.js';
import { ManualScheduler } from '../../src/services/scheduler.js';
import { MemoryObjectStore } from '../../src/services/storage.js';

/** Captures what the adapter writes to the Cloud Functions (Express) response. */
class FakeResponse {
  statusCode = 0;
  headers: Record<string, OutgoingHttpHeader> = {};
  body: Buffer | undefined;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: OutgoingHttpHeader) {
    this.headers[name] = value;
    return this;
  }
  end(body?: Buffer) {
    this.body = body;
    return this;
  }
  json() {
    return JSON.parse(this.body!.toString('utf8'));
  }
}

const request = (r: Partial<FnRequest> & Pick<FnRequest, 'url'>): FnRequest => ({ method: 'GET', headers: {}, ...r });

async function apiApp() {
  process.env.APP_ENV = 'test';
  const cfg = loadConfig({ env: 'test', scheduler: 'manual', notifier: 'log', projectId: 'demo-manhunt' });
  const deps: Deps = { cfg, db: {} as never, store: new MemoryObjectStore(), scheduler: new ManualScheduler(), notifier: new RecordingNotifier(), liveActivityTransport: new RecordingLiveActivityTransport(), clock: { now: () => Date.UTC(2026, 9, 18) }, log: createLogger(cfg, 'functions-http') };
  const app = await buildApiApp(deps, {
    verifyIdToken: async () => {
      throw new Error('invalid');
    },
  });
  await app.ready();
  return app;
}

describe('Cloud Functions → Fastify adapter', () => {
  it('strips the function name only as a leading path segment', () => {
    expect(stripFunctionPrefix('/api/v1/time')).toBe('/v1/time');
    expect(stripFunctionPrefix('/api')).toBe('/');
    expect(stripFunctionPrefix('/api?x=1')).toBe('/?x=1');
    expect(stripFunctionPrefix('/v1/time')).toBe('/v1/time');
    expect(stripFunctionPrefix('/apiv1/time')).toBe('/apiv1/time');
    expect(stripFunctionPrefix('/v1/api/x')).toBe('/v1/api/x');
  });

  it('serves public routes through the real API app, with or without the /api prefix', async () => {
    const app = await apiApp();
    const handle = fastifyHandler(async () => app);
    for (const url of ['/v1/time', '/api/v1/time']) {
      const res = new FakeResponse();
      await handle(request({ url }), res);
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/json');
      expect(res.json()).toEqual({ serverTime: '2026-10-18T00:00:00.000Z' });
    }
    await app.close();
  });

  it('keeps the API auth hook: no or bad token → 401, and /internal is not routed', async () => {
    const app = await apiApp();
    const handle = fastifyHandler(async () => app);
    const anon = new FakeResponse();
    await handle(request({ url: '/v1/me' }), anon);
    expect(anon.statusCode).toBe(401);
    expect(anon.json().error.code).toBe('UNAUTHENTICATED');
    const forged = new FakeResponse();
    await handle(request({ url: '/v1/me', headers: { authorization: 'Bearer forged' } }), forged);
    expect(forged.statusCode).toBe(401);
    const internal = new FakeResponse();
    await handle(request({ method: 'POST', url: '/internal/rounds/tick', headers: { authorization: 'Bearer forged', 'content-type': 'application/json' }, rawBody: Buffer.from('{}') }), internal);
    expect([401, 404]).toContain(internal.statusCode);
    await app.close();
  });

  it('replays the already-read body and enforces Fastify body limits and content types', async () => {
    const app = Fastify();
    app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 16 }, (_req, body, done) => done(null, body));
    app.post('/echo', async (req) => ({ body: Buffer.isBuffer(req.body) ? `jpeg:${req.body.length}` : req.body, ip: req.ip, contentLength: req.headers['content-length'] }));
    await app.ready();
    const handle = fastifyHandler(async () => app);

    const json = new FakeResponse();
    // The Functions Framework already consumed the stream; a stale content-length or chunked header must not leak.
    await handle(request({ method: 'POST', url: '/echo', ip: '203.0.113.7', headers: { 'content-type': 'application/json', 'content-length': '999', 'transfer-encoding': 'chunked' }, rawBody: Buffer.from('{"a":1}') }), json);
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({ body: { a: 1 }, ip: '203.0.113.7', contentLength: '7' });
    expect(json.headers['transfer-encoding']).toBeUndefined();

    const photo = new FakeResponse();
    await handle(request({ method: 'POST', url: '/echo', headers: { 'content-type': 'image/jpeg' }, rawBody: Buffer.alloc(10, 1) }), photo);
    expect(photo.json().body).toBe('jpeg:10');

    const tooBig = new FakeResponse();
    await handle(request({ method: 'POST', url: '/echo', headers: { 'content-type': 'image/jpeg' }, rawBody: Buffer.alloc(17, 1) }), tooBig);
    expect(tooBig.statusCode).toBe(413);

    const unsupported = new FakeResponse();
    await handle(request({ method: 'POST', url: '/echo', headers: { 'content-type': 'image/png' }, rawBody: Buffer.alloc(4, 1) }), unsupported);
    expect(unsupported.statusCode).toBe(415);
    await app.close();
  });
});
