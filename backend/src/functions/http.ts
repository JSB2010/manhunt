import type { FastifyInstance, InjectOptions } from 'fastify';
import type { IncomingHttpHeaders, OutgoingHttpHeader } from 'node:http';

/** The parts of the Cloud Functions (Express) request/response the adapter uses. */
export interface FnRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody?: Buffer | undefined;
  ip?: string | undefined;
}

export interface FnResponse {
  status(code: number): unknown;
  setHeader(name: string, value: OutgoingHttpHeader): unknown;
  end(body?: Buffer): unknown;
}

// Recomputed for the replayed request/response; never forwarded.
const DROP_REQUEST = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']);
const DROP_RESPONSE = new Set(['transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']);

/** `/api/v1/time` → `/v1/time`, for calls through the cloudfunctions.net URL or a Hosting rewrite. */
export function stripFunctionPrefix(url: string, name = 'api'): string {
  const stripped = url.replace(new RegExp(`^/${name}(?=/|\\?|$)`), '');
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

/**
 * Cloud Functions hands over an Express request whose body the Functions
 * Framework has already read into `rawBody`, so Fastify can't consume the
 * stream itself. Replaying it through `inject` runs the same pipeline the
 * tests drive: content-type parsers, body limits, the auth hook, error mapping.
 * Responses are small JSON or one ≤ 8 MB photo, so buffering them is fine.
 */
export function fastifyHandler(getApp: () => Promise<FastifyInstance>, name = 'api') {
  return async (req: FnRequest, res: FnResponse): Promise<void> => {
    const app = await getApp();
    const headers: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQUEST.has(k)) headers[k] = v;
    const out = await app.inject({
      method: req.method as InjectOptions['method'],
      url: stripFunctionPrefix(req.url, name),
      headers,
      ...(req.rawBody?.length ? { payload: req.rawBody } : {}),
      ...(req.ip ? { remoteAddress: req.ip } : {}),
    });
    res.status(out.statusCode);
    for (const [k, v] of Object.entries(out.headers)) if (v !== undefined && !DROP_RESPONSE.has(k)) res.setHeader(k, v);
    res.end(out.rawPayload);
  };
}
