import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../schemas/api.js';
import { uidOf, type Services } from '../app.js';

const R = z.object({ id: z.string().min(1).max(128), rid: z.string().min(1).max(128) });

export function registerDataRoutes(app: FastifyInstance, s: Services) {
  app.get('/v1/sessions/:id/rounds/:rid/summary', async (req) => {
    const p = parse(R, req.params);
    return s.data.roundSummary(uidOf(req), p.id, p.rid);
  });

  app.get('/v1/sessions/:id/rounds/:rid/routes', async (req, reply) => {
    const p = parse(R, req.params);
    const { format } = parse(z.object({ format: z.enum(['json', 'geojson']).default('json') }), req.query);
    const body = await s.data.routes(uidOf(req), p.id, p.rid, format);
    if (format === 'geojson') reply.type('application/geo+json');
    return body;
  });

  app.get('/v1/sessions/:id/analytics', async (req) => s.data.sessionAnalytics(uidOf(req), parse(z.object({ id: z.string().min(1).max(128) }), req.params).id));

  app.get('/v1/analytics/people/:personId', async (req) =>
    s.data.personStats(uidOf(req), parse(z.object({ personId: z.string().min(1).max(128) }), req.params).personId),
  );

  app.get('/v1/export/sessions/:file', { config: { rateLimit: 'export' } }, async (req, reply) => {
    const { file } = parse(z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{1,128}\.(csv|json)$/) }), req.params);
    const [id, ext] = file.split('.') as [string, 'csv' | 'json'];
    const out = await s.data.exportSession(uidOf(req), id, ext);
    return reply.type(out.contentType).header('content-disposition', `attachment; filename="manhunt-${id}.${ext}"`).send(out.body);
  });
}
