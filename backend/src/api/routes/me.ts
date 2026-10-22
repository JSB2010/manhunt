import type { FastifyInstance } from 'fastify';
import { LiveActivityStartTokenBody, parse, PatchMeBody, PushTokenBody } from '../../schemas/api.js';
import { uidOf, type Services } from '../app.js';

export function registerMeRoutes(app: FastifyInstance, s: Services) {
  app.get('/v1/me', async (req) => s.social.me(uidOf(req)));

  app.patch('/v1/me', async (req) => s.social.patchMe(uidOf(req), parse(PatchMeBody, req.body)));

  app.delete('/v1/me', { config: { rateLimit: 'account' } }, async (req) => s.data.deleteAccount(uidOf(req)));

  app.post('/v1/devices/push-token', async (req) => s.social.registerPushToken(uidOf(req), parse(PushTokenBody, req.body)));

  app.post('/v1/devices/live-activity-token', async (req) => s.liveActivities.registerStartToken(uidOf(req), parse(LiveActivityStartTokenBody, req.body)));
}
