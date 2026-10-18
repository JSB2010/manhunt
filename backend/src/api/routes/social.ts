import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateGroupBody,
  CreatePersonBody,
  FriendRequestBody,
  LinkRespondBody,
  MergePersonBody,
  parse,
  PatchGroupBody,
  PatchPersonBody,
  RespondBody,
} from '../../schemas/api.js';
import { uidOf, type Services } from '../app.js';

const Id = z.object({ id: z.string().min(1).max(128) });
const Uid = z.object({ uid: z.string().min(1).max(128) });

export function registerSocialRoutes(app: FastifyInstance, s: Services) {
  // Friends
  app.post('/v1/friends/requests', { config: { rateLimit: 'friend' } }, async (req) => s.social.sendFriendRequest(uidOf(req), parse(FriendRequestBody, req.body)));
  app.get('/v1/friends/requests', async (req) => s.social.listFriendRequests(uidOf(req)));
  app.post('/v1/friends/requests/:id/respond', async (req) => s.social.respondFriendRequest(uidOf(req), parse(Id, req.params).id, parse(RespondBody, req.body).accept));
  app.get('/v1/friends', async (req) => s.social.listFriends(uidOf(req)));
  app.delete('/v1/friends/:uid', async (req) => s.social.removeFriend(uidOf(req), parse(Uid, req.params).uid));
  app.post('/v1/friends/:uid/block', async (req) => s.social.block(uidOf(req), parse(Uid, req.params).uid));
  app.delete('/v1/blocks/:uid', async (req) => s.social.unblock(uidOf(req), parse(Uid, req.params).uid));
  app.post('/v1/friends/invite-token/rotate', { config: { rateLimit: 'friend' } }, async (req) => s.social.rotateFriendToken(uidOf(req)));

  // People
  app.get('/v1/people', async (req) => s.social.listPeople(uidOf(req), parse(z.object({ q: z.string().max(60).optional() }), req.query).q));
  app.post('/v1/people', async (req) => s.social.createPerson(uidOf(req), parse(CreatePersonBody, req.body)));
  app.patch('/v1/people/:id', async (req) => s.social.patchPerson(uidOf(req), parse(Id, req.params).id, parse(PatchPersonBody, req.body)));
  app.post('/v1/people/:id/merge', async (req) => s.social.mergePerson(uidOf(req), parse(Id, req.params).id, parse(MergePersonBody, req.body).intoPersonId));
  app.post('/v1/people/:id/link-requests', { config: { rateLimit: 'friend' } }, async (req) => s.social.requestLink(uidOf(req), parse(Id, req.params).id));
  app.get('/v1/people/link-requests', async (req) => s.social.listLinkRequests(uidOf(req)));
  app.post('/v1/people/link-requests/:id/respond', async (req) => s.social.respondLink(uidOf(req), parse(Id, req.params).id, parse(LinkRespondBody, req.body).approve));

  // Groups
  app.get('/v1/groups', async (req) => s.social.listGroups(uidOf(req)));
  app.post('/v1/groups', async (req) => s.social.createGroup(uidOf(req), parse(CreateGroupBody, req.body)));
  app.patch('/v1/groups/:id', async (req) => s.social.patchGroup(uidOf(req), parse(Id, req.params).id, parse(PatchGroupBody, req.body)));
  app.delete('/v1/groups/:id', async (req) => s.social.deleteGroup(uidOf(req), parse(Id, req.params).id));
}
