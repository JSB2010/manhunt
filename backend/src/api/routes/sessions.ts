import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ConsentBody,
  CreateInviteBody,
  CreateSessionBody,
  KeepPhotosBody,
  NextRoundBody,
  parse,
  PreviewInviteBody,
  ReadyBody,
  RedeemInviteBody,
  SetupPatchBody,
} from '../../schemas/api.js';
import { uidOf, type Services } from '../app.js';

const Sid = z.object({ id: z.string().min(1).max(128) });

export function registerSessionRoutes(app: FastifyInstance, s: Services) {
  app.post('/v1/sessions', async (req) => s.game.createSession(uidOf(req), parse(CreateSessionBody, req.body)));

  app.get('/v1/sessions', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), q: z.string().max(60).optional(), before: z.coerce.number().int().optional() }), req.query);
    return s.game.listSessions(uidOf(req), q);
  });

  // Conditional GET: the view's content hash is its ETag, so an unchanged view costs a 304 with no body.
  app.get('/v1/sessions/:id', async (req, reply) => {
    const v = await s.game.getView(uidOf(req), parse(Sid, req.params).id);
    if (v.viewHash) {
      const etag = `"${v.viewHash}"`;
      reply.header('etag', etag);
      if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    }
    return v;
  });

  app.post('/v1/sessions/:id/invites', async (req) =>
    s.game.createInvite(uidOf(req), parse(Sid, req.params).id, parse(CreateInviteBody, req.body)),
  );

  // Code lookups: only failed attempts count toward the brute-force limit.
  app.post('/v1/invites/preview', { config: { rateLimit: 'join' } }, async (req) => s.game.previewInvite(uidOf(req), parse(PreviewInviteBody, req.body)));

  app.post('/v1/invites/redeem', { config: { rateLimit: 'join' } }, async (req) => s.game.redeemInvite(uidOf(req), parse(RedeemInviteBody, req.body)));

  app.patch('/v1/sessions/:id/setup', async (req) => s.game.editSetup(uidOf(req), parse(Sid, req.params).id, parse(SetupPatchBody, req.body)));

  app.post('/v1/sessions/:id/consent', async (req) => s.game.setConsent(uidOf(req), parse(Sid, req.params).id, parse(ConsentBody, req.body)));

  app.post('/v1/sessions/:id/ready', async (req) => {
    const b = parse(ReadyBody, req.body);
    return s.game.setReady(uidOf(req), parse(Sid, req.params).id, b.ready, b.preflight);
  });

  app.post('/v1/sessions/:id/next-round', async (req) => s.game.nextRound(uidOf(req), parse(Sid, req.params).id, parse(NextRoundBody, req.body)));

  app.post('/v1/sessions/:id/complete', async (req) => s.game.completeSession(uidOf(req), parse(Sid, req.params).id));

  app.post('/v1/sessions/:id/keep-photos', async (req) => s.game.setKeepPhotos(uidOf(req), parse(Sid, req.params).id, parse(KeepPhotosBody, req.body).keep));

  app.delete('/v1/sessions/:id', { config: { rateLimit: 'account' } }, async (req) => s.data.deleteSession(uidOf(req), parse(Sid, req.params).id));

  app.delete('/v1/sessions/:id/my-data', { config: { rateLimit: 'account' } }, async (req) => s.data.deleteMyData(uidOf(req), parse(Sid, req.params).id));

  app.post('/v1/sessions/:id/revoke', { config: { rateLimit: 'account' } }, async (req) => s.data.revokeSession(uidOf(req), parse(Sid, req.params).id));
}
