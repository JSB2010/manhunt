import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { AbortBody, CaptureCompleteBody, DecisionBody, DeviceIdParam, DisputeBody, LiveActivityTokenBody, LocationBatchBody, parse, PauseBody, StartBody } from '../../schemas/api.js';
import { uidOf, type Services } from '../app.js';

const R = z.object({ id: z.string().min(1).max(128), rid: z.string().min(1).max(128) });
const RC = R.extend({ cid: z.string().min(1).max(128) });
const RD = R.extend({ deviceId: DeviceIdParam });

export function registerGameRoutes(app: FastifyInstance, s: Services) {
  app.post('/v1/sessions/:id/rounds/:rid/start', async (req) => {
    const p = parse(R, req.params);
    return s.game.startRound(uidOf(req), p.id, p.rid, parse(StartBody, req.body).acknowledgeWarnings);
  });

  app.post('/v1/sessions/:id/rounds/:rid/pause', async (req) => {
    const p = parse(R, req.params);
    return s.game.pause(uidOf(req), p.id, p.rid, parse(PauseBody, req.body));
  });

  app.post('/v1/sessions/:id/rounds/:rid/resume', async (req) => {
    const p = parse(R, req.params);
    return s.game.resume(uidOf(req), p.id, p.rid);
  });

  app.post('/v1/sessions/:id/rounds/:rid/abort', async (req) => {
    const p = parse(R, req.params);
    return s.game.abort(uidOf(req), p.id, p.rid, parse(AbortBody, req.body));
  });

  app.post('/v1/sessions/:id/rounds/:rid/location-batches', { config: { rateLimit: 'location' }, bodyLimit: 512_000 }, async (req) => {
    const p = parse(R, req.params);
    return s.game.ingestLocations(uidOf(req), p.id, p.rid, parse(LocationBatchBody, req.body));
  });

  app.get('/v1/sessions/:id/rounds/:rid/my-track', async (req) => {
    const p = parse(R, req.params);
    return s.game.myTrack(uidOf(req), p.id, p.rid);
  });

  app.post('/v1/sessions/:id/rounds/:rid/captures/init', { config: { rateLimit: 'capture' } }, async (req) => {
    const p = parse(R, req.params);
    return s.game.captureInit(uidOf(req), p.id, p.rid);
  });

  app.put('/v1/sessions/:id/rounds/:rid/captures/:cid/photo', { config: { rateLimit: 'capture' } }, async (req) => {
    const p = parse(RC, req.params);
    if (req.headers['content-type'] !== 'image/jpeg' || !Buffer.isBuffer(req.body)) throw new AppError('UNSUPPORTED_MEDIA', 'Send the photo as image/jpeg');
    return s.game.capturePhoto(uidOf(req), p.id, p.rid, p.cid, req.body);
  });

  app.post('/v1/sessions/:id/rounds/:rid/captures/complete', { config: { rateLimit: 'capture' } }, async (req) => {
    const p = parse(R, req.params);
    return s.game.captureComplete(uidOf(req), p.id, p.rid, parse(CaptureCompleteBody, req.body).claimId);
  });

  app.post('/v1/sessions/:id/rounds/:rid/captures/:cid/decision', async (req) => {
    const p = parse(RC, req.params);
    const b = parse(DecisionBody, req.body);
    return s.game.captureDecision(uidOf(req), p.id, p.rid, p.cid, b.decision, b.reason ?? null);
  });

  app.get('/v1/sessions/:id/rounds/:rid/captures/:cid/photo', async (req, reply) => {
    const p = parse(RC, req.params);
    const bytes = await s.game.getCapturePhoto(uidOf(req), p.id, p.rid, p.cid);
    return reply.type('image/jpeg').header('content-disposition', 'inline').send(bytes);
  });

  app.post('/v1/sessions/:id/rounds/:rid/captures/:cid/dispute', async (req) => {
    const p = parse(RC, req.params);
    return s.game.resolveDispute(uidOf(req), p.id, p.rid, p.cid, parse(DisputeBody, req.body).resolution);
  });

  app.put('/v1/sessions/:id/rounds/:rid/live-activity/:deviceId', async (req) => {
    const p = parse(RD, req.params);
    return s.liveActivities.register(uidOf(req), p.id, p.rid, p.deviceId, parse(LiveActivityTokenBody, req.body));
  });

  app.delete('/v1/sessions/:id/rounds/:rid/live-activity/:deviceId', async (req) => {
    const p = parse(RD, req.params);
    return s.liveActivities.unregister(uidOf(req), p.id, p.rid, p.deviceId);
  });
}
