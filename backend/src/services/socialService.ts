import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { fail } from '../domain/errors.js';
import type { PersonRef } from '../domain/types.js';
import type { CreateGroupBody, CreatePersonBody, PatchGroupBody, PatchMeBody, PatchPersonBody, PushTokenBody, RosterEntry } from '../schemas/api.js';
import { paths, type Deps } from './repo.js';

/**
 * Accounts, friends, guest people and reusable groups (spec §2, §12).
 *
 * - UIDs are accounts; personIds are humans (may have no account).
 * - Friendship never grants location access.
 * - People are visible to their creator, their linked account, and members of
 *   groups that include them. They are never globally searchable.
 */

export interface UserDoc {
  uid: string;
  displayName: string;
  handle: string | null;
  email: string | null;
  selfPersonId: string;
  preferences: { units: 'MILES' | 'KILOMETERS'; notifyPings: boolean; notifyRoundEvents: boolean };
  friendInviteToken: string;
  createdAt: number;
  updatedAt: number;
  deletion: { requestedAt: number; status: string } | null;
}

export interface PersonDoc {
  id: string;
  displayName: string;
  aliases: string[];
  createdByUid: string;
  linkedUid: string | null;
  isSelf: boolean;
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupDoc {
  id: string;
  name: string;
  ownerUid: string;
  editorUids: string[];
  memberUids: string[];
  personIds: string[];
  createdAt: number;
  updatedAt: number;
}

const RESERVED_HANDLES = new Set(['admin', 'root', 'support', 'manhunt', 'system', 'null', 'undefined', 'me', 'help', 'official']);
export const pairId = (a: string, b: string) => [a, b].sort().join('_');
const token = () => randomBytes(18).toString('base64url');
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function publicProfile(u: UserDoc) {
  return { uid: u.uid, displayName: u.displayName, handle: u.handle };
}

export class SocialService {
  private p;
  private provisioned = new Set<string>();
  constructor(private d: Deps) {
    this.p = paths(d.db);
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  /** Lazily create the account profile and the user's own linked person record. */
  async ensureUser(uid: string, claims: { email?: string | undefined; name?: string | undefined }): Promise<UserDoc> {
    const ref = this.p.user(uid);
    if (this.provisioned.has(uid)) {
      const snap = await ref.get();
      if (snap.exists) return snap.data() as UserDoc;
    }
    const now = this.d.clock.now();
    const user = await this.d.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return snap.data() as UserDoc;
      const displayName = (claims.name ?? claims.email?.split('@')[0] ?? 'Operator').slice(0, 60);
      const personRef = this.p.people().doc();
      const tok = token();
      const u: UserDoc = {
        uid,
        displayName,
        handle: null,
        email: claims.email ?? null,
        selfPersonId: personRef.id,
        preferences: { units: 'MILES', notifyPings: true, notifyRoundEvents: true },
        friendInviteToken: tok,
        createdAt: now,
        updatedAt: now,
        deletion: null,
      };
      const person: PersonDoc = { id: personRef.id, displayName, aliases: [], createdByUid: uid, linkedUid: uid, isSelf: true, mergedInto: null, createdAt: now, updatedAt: now };
      tx.create(ref, u);
      tx.create(personRef, person);
      tx.create(this.p.friendTokens(tok), { uid, createdAt: now });
      return u;
    });
    this.provisioned.add(uid);
    return user;
  }

  async me(uid: string) {
    const u = (await this.p.user(uid).get()).data() as UserDoc;
    const now = this.d.clock.now();
    const [friends, incoming, invites, active] = await Promise.all([
      this.p.friendships().where('uids', 'array-contains', uid).where('blocked', '==', false).count().get(),
      this.p.friendRequests().where('toUid', '==', uid).where('status', '==', 'PENDING').count().get(),
      this.p.invites().where('targetUid', '==', uid).where('revoked', '==', false).get(),
      this.p.sessions().where('memberUids', 'array-contains', uid).where('status', 'in', ['LOBBY', 'IN_ROUND', 'BETWEEN_ROUNDS']).orderBy('updatedAt', 'desc').limit(5).get(),
    ]);
    const groups = await this.p.groups().where('memberUids', 'array-contains', uid).count().get();
    return {
      profile: {
        uid: u.uid,
        displayName: u.displayName,
        handle: u.handle,
        email: u.email,
        selfPersonId: u.selfPersonId,
        preferences: u.preferences,
        friendInviteLink: `manhuntcrews://friend?token=${u.friendInviteToken}`,
        createdAt: new Date(u.createdAt).toISOString(),
      },
      counts: { friends: friends.data().count, incomingFriendRequests: incoming.data().count, groups: groups.data().count },
      pendingSessionInvites: invites.docs
        .map((d) => d.data())
        .filter((i) => i.expiresAt > now && i.uses < i.maxUses)
        .map((i) => ({ inviteId: i.id as string, sessionId: i.sessionId as string, sessionTitle: i.sessionTitle as string, teamName: i.teamName as string, hostDisplayName: i.hostDisplayName as string | null, expiresAt: new Date(i.expiresAt).toISOString() })),
      activeSessions: active.docs.map((d) => {
        const s = d.data();
        return { id: s.id as string, title: s.title as string, status: s.status as string, scheduledDate: s.scheduledDate as string };
      }),
    };
  }

  async patchMe(uid: string, body: z.infer<typeof PatchMeBody>) {
    const now = this.d.clock.now();
    await this.d.db.runTransaction(async (tx) => {
      const ref = this.p.user(uid);
      const u = (await tx.get(ref)).data() as UserDoc;
      const update: Partial<UserDoc> = { updatedAt: now };
      if (body.handle && body.handle !== u.handle) {
        if (RESERVED_HANDLES.has(body.handle)) fail('VALIDATION_FAILED', 'That handle is reserved');
        const h = await tx.get(this.p.handle(body.handle));
        if (h.exists && h.get('uid') !== uid) fail('CONFLICT', 'Handle already taken');
        if (u.handle) tx.delete(this.p.handle(u.handle));
        tx.set(this.p.handle(body.handle), { uid, createdAt: now });
        update.handle = body.handle;
      }
      if (body.displayName) {
        update.displayName = body.displayName;
        // Keep the self-person's *current* name in sync; historical snapshots are untouched.
        tx.update(this.p.person(u.selfPersonId), { displayName: body.displayName, updatedAt: now });
      }
      if (body.preferences) update.preferences = { ...u.preferences, ...body.preferences };
      tx.update(ref, update);
    });
    return this.me(uid);
  }

  async registerPushToken(uid: string, body: z.infer<typeof PushTokenBody>) {
    await this.p.devices(uid).doc(body.deviceId).set({ fcmToken: body.fcmToken, apnsEnvironment: body.apnsEnvironment, appVersion: body.appVersion ?? null, updatedAt: this.d.clock.now() });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Friends
  // -------------------------------------------------------------------------

  async sendFriendRequest(uid: string, body: { handle?: string | undefined; inviteToken?: string | undefined }) {
    const now = this.d.clock.now();
    let toUid: string | undefined;
    if (body.handle) toUid = (await this.p.handle(body.handle).get()).get('uid');
    else toUid = (await this.p.friendTokens(body.inviteToken!).get()).get('uid');
    if (!toUid) fail('NOT_FOUND', 'No account with that handle or invite');
    if (toUid === uid) fail('VALIDATION_FAILED', 'You cannot friend yourself');
    const fid = pairId(uid, toUid!);
    const existing = await this.p.friendship(fid).get();
    if (existing.exists) {
      if (existing.get('blocked')) fail('NOT_FOUND', 'No account with that handle or invite');
      return { status: 'ALREADY_FRIENDS' };
    }
    const reverse = await this.p.friendRequests().where('fromUid', '==', toUid).where('toUid', '==', uid).where('status', '==', 'PENDING').limit(1).get();
    if (!reverse.empty) {
      // They already asked us: accept immediately.
      return this.respondFriendRequest(uid, reverse.docs[0]!.id, true);
    }
    const dup = await this.p.friendRequests().where('fromUid', '==', uid).where('toUid', '==', toUid).where('status', '==', 'PENDING').limit(1).get();
    if (!dup.empty) return { status: 'PENDING', requestId: dup.docs[0]!.id };
    const via = body.inviteToken ? 'INVITE_LINK' : 'HANDLE';
    const ref = this.p.friendRequests().doc();
    await ref.create({ id: ref.id, fromUid: uid, toUid, status: 'PENDING', via, createdAt: now, updatedAt: now });
    const from = (await this.p.user(uid).get()).data() as UserDoc;
    this.d.notifier.send([{ toUids: [toUid!], kind: 'FRIEND_REQUEST', title: 'Friend request', body: `${from.displayName} wants to add you on Manhunt Crews.`, sessionId: '', roundId: null }]).catch(() => undefined);
    return { status: 'PENDING', requestId: ref.id };
  }

  async listFriendRequests(uid: string) {
    const [inc, out] = await Promise.all([
      this.p.friendRequests().where('toUid', '==', uid).where('status', '==', 'PENDING').get(),
      this.p.friendRequests().where('fromUid', '==', uid).where('status', '==', 'PENDING').get(),
    ]);
    const uids = [...new Set([...inc.docs.map((d) => d.get('fromUid')), ...out.docs.map((d) => d.get('toUid'))])] as string[];
    const profiles = await this.profiles(uids);
    const fmt = (d: FirebaseFirestore.QueryDocumentSnapshot, other: string) => ({ requestId: d.id, user: profiles[other] ?? { uid: other, displayName: 'Unknown', handle: null }, createdAt: new Date(d.get('createdAt')).toISOString() });
    return { incoming: inc.docs.map((d) => fmt(d, d.get('fromUid'))), outgoing: out.docs.map((d) => fmt(d, d.get('toUid'))) };
  }

  async respondFriendRequest(uid: string, requestId: string, accept: boolean) {
    const now = this.d.clock.now();
    return this.d.db.runTransaction(async (tx) => {
      const ref = this.p.friendRequest(requestId);
      const req = (await tx.get(ref)).data();
      if (!req || req.toUid !== uid) fail('NOT_FOUND', 'Request not found');
      if (req!.status !== 'PENDING') return { status: req!.status as string };
      tx.update(ref, { status: accept ? 'ACCEPTED' : 'DECLINED', updatedAt: now });
      if (accept) {
        tx.set(this.p.friendship(pairId(req!.fromUid, uid)), { id: pairId(req!.fromUid, uid), uids: [req!.fromUid, uid].sort(), acceptedAt: now, blocked: false, blockedByUid: null });
      }
      return { status: accept ? 'ACCEPTED' : 'DECLINED' };
    });
  }

  async listFriends(uid: string) {
    const snap = await this.p.friendships().where('uids', 'array-contains', uid).get();
    const others = snap.docs.filter((d) => !d.get('blocked')).map((d) => (d.get('uids') as string[]).find((u) => u !== uid)!);
    const blocked = snap.docs.filter((d) => d.get('blocked') && d.get('blockedByUid') === uid).map((d) => (d.get('uids') as string[]).find((u) => u !== uid)!);
    const profiles = await this.profiles([...others, ...blocked]);
    return {
      friends: others.map((u) => profiles[u]).filter(Boolean),
      blocked: blocked.map((u) => profiles[u]).filter(Boolean),
    };
  }

  async removeFriend(uid: string, other: string) {
    const ref = this.p.friendship(pairId(uid, other));
    const snap = await ref.get();
    if (!snap.exists) fail('NOT_FOUND', 'Not friends');
    if (snap.get('blocked') && snap.get('blockedByUid') !== uid) fail('NOT_FOUND', 'Not friends');
    await ref.delete();
    return { ok: true };
  }

  async block(uid: string, other: string) {
    if (uid === other) fail('VALIDATION_FAILED', 'Cannot block yourself');
    const now = this.d.clock.now();
    await this.p.friendship(pairId(uid, other)).set({ id: pairId(uid, other), uids: [uid, other].sort(), acceptedAt: null, blocked: true, blockedByUid: uid, blockedAt: now });
    const pending = await this.p.friendRequests().where('fromUid', 'in', [uid, other]).where('status', '==', 'PENDING').get();
    await Promise.all(pending.docs.filter((d) => [uid, other].includes(d.get('toUid'))).map((d) => d.ref.update({ status: 'DECLINED', updatedAt: now })));
    return { ok: true };
  }

  async unblock(uid: string, other: string) {
    const ref = this.p.friendship(pairId(uid, other));
    const snap = await ref.get();
    if (snap.exists && snap.get('blocked') && snap.get('blockedByUid') === uid) await ref.delete();
    return { ok: true };
  }

  async rotateFriendToken(uid: string) {
    const now = this.d.clock.now();
    const u = (await this.p.user(uid).get()).data() as UserDoc;
    const tok = token();
    const batch = this.d.db.batch();
    batch.delete(this.p.friendTokens(u.friendInviteToken));
    batch.create(this.p.friendTokens(tok), { uid, createdAt: now });
    batch.update(this.p.user(uid), { friendInviteToken: tok, updatedAt: now });
    await batch.commit();
    return { friendInviteLink: `manhuntcrews://friend?token=${tok}` };
  }

  async areFriends(a: string, b: string) {
    const snap = await this.p.friendship(pairId(a, b)).get();
    return snap.exists && !snap.get('blocked');
  }

  private async profiles(uids: string[]) {
    const out: Record<string, ReturnType<typeof publicProfile>> = {};
    if (!uids.length) return out;
    const snaps = await this.d.db.getAll(...uids.map((u) => this.p.user(u)));
    for (const s of snaps) if (s.exists) out[s.id] = publicProfile(s.data() as UserDoc);
    return out;
  }

  // -------------------------------------------------------------------------
  // People (stable person identities, guests included)
  // -------------------------------------------------------------------------

  async visiblePeople(uid: string): Promise<PersonDoc[]> {
    const [mine, linked, groups] = await Promise.all([
      this.p.people().where('createdByUid', '==', uid).get(),
      this.p.people().where('linkedUid', '==', uid).get(),
      this.p.groups().where('memberUids', 'array-contains', uid).get(),
    ]);
    const map = new Map<string, PersonDoc>();
    for (const d of [...mine.docs, ...linked.docs]) map.set(d.id, d.data() as PersonDoc);
    const groupIds = [...new Set(groups.docs.flatMap((g) => g.get('personIds') as string[]))].filter((id) => !map.has(id));
    for (let i = 0; i < groupIds.length; i += 100) {
      const snaps = await this.d.db.getAll(...groupIds.slice(i, i + 100).map((id) => this.p.person(id)));
      for (const s of snaps) if (s.exists) map.set(s.id, s.data() as PersonDoc);
    }
    return [...map.values()];
  }

  async canSeePerson(uid: string, personId: string): Promise<PersonDoc | null> {
    const snap = await this.p.person(personId).get();
    if (!snap.exists) return null;
    const p = snap.data() as PersonDoc;
    if (p.createdByUid === uid || p.linkedUid === uid) return p;
    const g = await this.p.groups().where('memberUids', 'array-contains', uid).where('personIds', 'array-contains', personId).limit(1).get();
    if (!g.empty) return p;
    // People who appeared in a session the user played in are visible (names are already in that session's snapshot).
    const s = await this.p.sessions().where('memberUids', 'array-contains', uid).where('participantPersonIds', 'array-contains', personId).limit(1).get().catch(() => null);
    return s && !s.empty ? p : null;
  }

  async listPeople(uid: string, query?: string) {
    let people = (await this.visiblePeople(uid)).filter((p) => !p.mergedInto);
    if (query) {
      const q = norm(query);
      people = people.filter((p) => [p.displayName, ...p.aliases].some((n) => norm(n).includes(q)));
    }
    return { people: people.sort((a, b) => a.displayName.localeCompare(b.displayName)).map((p) => this.personOut(p, uid)) };
  }

  personOut(p: PersonDoc, uid: string) {
    return { id: p.id, displayName: p.displayName, aliases: p.aliases, isSelf: p.isSelf && p.linkedUid === uid, hasAccount: !!p.linkedUid, canEdit: p.createdByUid === uid, mergedInto: p.mergedInto };
  }

  async createPerson(uid: string, body: z.infer<typeof CreatePersonBody>) {
    const now = this.d.clock.now();
    const name = norm(body.displayName);
    const dupes = (await this.visiblePeople(uid)).filter((p) => !p.mergedInto && [p.displayName, ...p.aliases].some((n) => norm(n) === name));
    if (dupes.length && !body.confirmNew) {
      // Encourage matching the right saved person rather than silently creating duplicates.
      return { created: false, possibleDuplicates: dupes.map((p) => this.personOut(p, uid)) };
    }
    const ref = this.p.people().doc();
    const person: PersonDoc = { id: ref.id, displayName: body.displayName, aliases: body.aliases ?? [], createdByUid: uid, linkedUid: null, isSelf: false, mergedInto: null, createdAt: now, updatedAt: now };
    await ref.create(person);
    return { created: true, person: this.personOut(person, uid), possibleDuplicates: [] };
  }

  async patchPerson(uid: string, id: string, body: z.infer<typeof PatchPersonBody>) {
    const ref = this.p.person(id);
    const p = (await ref.get()).data() as PersonDoc | undefined;
    if (!p || (p.createdByUid !== uid && p.linkedUid !== uid)) fail('NOT_FOUND', 'Person not found');
    // Historical crew snapshots keep the names used at the time.
    await ref.update({ ...body, updatedAt: this.d.clock.now() });
    return this.personOut({ ...p!, ...body }, uid);
  }

  /** Merge a duplicate guest into a canonical record. Both must be created by the caller; linked accounts cannot be merged away. */
  async mergePerson(uid: string, id: string, intoId: string) {
    if (id === intoId) fail('VALIDATION_FAILED', 'Cannot merge a person into themselves');
    return this.d.db.runTransaction(async (tx) => {
      const a = (await tx.get(this.p.person(id))).data() as PersonDoc | undefined;
      const b = (await tx.get(this.p.person(intoId))).data() as PersonDoc | undefined;
      if (!a || !b || a.createdByUid !== uid || b.createdByUid !== uid) fail('FORBIDDEN', 'You can only merge people you created');
      if (a!.linkedUid) fail('FORBIDDEN', 'A person linked to an account cannot be merged away');
      if (b!.mergedInto) fail('VALIDATION_FAILED', 'Target was itself merged');
      const now = this.d.clock.now();
      tx.update(this.p.person(id), { mergedInto: intoId, updatedAt: now });
      tx.update(this.p.person(intoId), { aliases: [...new Set([...b!.aliases, a!.displayName, ...a!.aliases])].slice(0, 20), updatedAt: now });
      return { merged: true, into: intoId };
    });
  }

  /** Follow merge pointers to the canonical person id (bounded). */
  async resolvePersonIds(personId: string): Promise<{ canonical: string; all: Set<string> }> {
    let current = personId;
    for (let i = 0; i < 10; i++) {
      const p = (await this.p.person(current).get()).data() as PersonDoc | undefined;
      if (!p?.mergedInto) break;
      current = p.mergedInto;
    }
    const all = new Set<string>([current, personId]);
    const merged = await this.p.people().where('mergedInto', '==', current).get();
    for (const d of merged.docs) all.add(d.id);
    return { canonical: current, all };
  }

  /** An account holder asks to be linked to a guest person; the person's creator must approve. */
  async requestLink(uid: string, personId: string) {
    const p = (await this.p.person(personId).get()).data() as PersonDoc | undefined;
    if (!p || p.mergedInto) fail('NOT_FOUND', 'Person not found');
    if (p!.linkedUid) fail('CONFLICT', 'This person is already linked to an account');
    if (!(await this.areFriends(uid, p!.createdByUid))) fail('FORBIDDEN', 'Ask the organizer to add you as a friend first');
    const existing = await this.p.linkRequests().where('personId', '==', personId).where('requesterUid', '==', uid).where('status', '==', 'PENDING').limit(1).get();
    if (!existing.empty) return { status: 'PENDING', requestId: existing.docs[0]!.id };
    const ref = this.p.linkRequests().doc();
    await ref.create({ id: ref.id, personId, requesterUid: uid, organizerUid: p!.createdByUid, status: 'PENDING', createdAt: this.d.clock.now() });
    return { status: 'PENDING', requestId: ref.id };
  }

  async listLinkRequests(uid: string) {
    const snap = await this.p.linkRequests().where('organizerUid', '==', uid).where('status', '==', 'PENDING').get();
    const profiles = await this.profiles(snap.docs.map((d) => d.get('requesterUid')));
    return {
      requests: await Promise.all(
        snap.docs.map(async (d) => {
          const person = (await this.p.person(d.get('personId')).get()).data() as PersonDoc | undefined;
          return { requestId: d.id, person: person ? this.personOut(person, uid) : null, requester: profiles[d.get('requesterUid')] ?? null };
        }),
      ),
    };
  }

  async respondLink(uid: string, requestId: string, approve: boolean) {
    return this.d.db.runTransaction(async (tx) => {
      const ref = this.p.linkRequests().doc(requestId);
      const req = (await tx.get(ref)).data();
      if (!req || req.organizerUid !== uid || req.status !== 'PENDING') fail('NOT_FOUND', 'Request not found');
      const person = (await tx.get(this.p.person(req!.personId))).data() as PersonDoc;
      if (person.linkedUid) fail('CONFLICT', 'Already linked');
      tx.update(ref, { status: approve ? 'APPROVED' : 'DECLINED', decidedAt: this.d.clock.now() });
      if (approve) tx.update(this.p.person(req!.personId), { linkedUid: req!.requesterUid, updatedAt: this.d.clock.now() });
      return { status: approve ? 'APPROVED' : 'DECLINED' };
    });
  }

  // -------------------------------------------------------------------------
  // Reusable groups (roster templates)
  // -------------------------------------------------------------------------

  private async assertFriends(uid: string, uids: string[]) {
    for (const u of uids) if (u !== uid && !(await this.areFriends(uid, u))) fail('FORBIDDEN', 'Group members must be on your friends list');
  }

  private async assertPeopleVisible(uid: string, ids: string[]) {
    const visible = new Set((await this.visiblePeople(uid)).map((p) => p.id));
    const missing = ids.filter((id) => !visible.has(id));
    if (missing.length) fail('VALIDATION_FAILED', 'Some people are not in your saved people', { missing });
  }

  async listGroups(uid: string) {
    const snap = await this.p.groups().where('memberUids', 'array-contains', uid).get();
    const groups = snap.docs.map((d) => d.data() as GroupDoc);
    const ids = [...new Set(groups.flatMap((g) => g.personIds))];
    const people = new Map<string, PersonDoc>();
    for (let i = 0; i < ids.length; i += 100) {
      const snaps = await this.d.db.getAll(...ids.slice(i, i + 100).map((id) => this.p.person(id)));
      for (const s of snaps) if (s.exists) people.set(s.id, s.data() as PersonDoc);
    }
    return {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        isOwner: g.ownerUid === uid,
        canEdit: g.ownerUid === uid || g.editorUids.includes(uid),
        memberUids: g.memberUids,
        people: g.personIds.map((id) => people.get(id)).filter((p): p is PersonDoc => !!p).map((p) => this.personOut(p, uid)),
      })),
    };
  }

  async createGroup(uid: string, body: z.infer<typeof CreateGroupBody>) {
    await this.assertFriends(uid, body.memberUids);
    await this.assertFriends(uid, body.editorUids);
    await this.assertPeopleVisible(uid, body.personIds);
    const now = this.d.clock.now();
    const ref = this.p.groups().doc();
    const g: GroupDoc = {
      id: ref.id,
      name: body.name,
      ownerUid: uid,
      editorUids: [...new Set(body.editorUids.filter((u) => body.memberUids.includes(u)))],
      memberUids: [...new Set([uid, ...body.memberUids])],
      personIds: [...new Set(body.personIds)],
      createdAt: now,
      updatedAt: now,
    };
    await ref.create(g);
    return { id: g.id };
  }

  async patchGroup(uid: string, id: string, body: z.infer<typeof PatchGroupBody>) {
    const ref = this.p.group(id);
    const g = (await ref.get()).data() as GroupDoc | undefined;
    if (!g || !g.memberUids.includes(uid)) fail('NOT_FOUND', 'Group not found');
    if (g!.ownerUid !== uid && !g!.editorUids.includes(uid)) fail('FORBIDDEN', 'Only the owner or editors can change this group');
    if ((body.memberUids || body.editorUids) && g!.ownerUid !== uid) fail('FORBIDDEN', 'Only the owner can change group membership');
    if (body.memberUids) await this.assertFriends(uid, body.memberUids);
    if (body.personIds) await this.assertPeopleVisible(uid, body.personIds);
    const update: Partial<GroupDoc> = { updatedAt: this.d.clock.now() };
    if (body.name) update.name = body.name;
    if (body.personIds) update.personIds = [...new Set(body.personIds)];
    if (body.memberUids) update.memberUids = [...new Set([g!.ownerUid, ...body.memberUids])];
    if (body.editorUids) update.editorUids = body.editorUids.filter((u) => (update.memberUids ?? g!.memberUids).includes(u));
    await ref.update(update);
    return { ok: true };
  }

  async deleteGroup(uid: string, id: string) {
    const ref = this.p.group(id);
    const g = (await ref.get()).data() as GroupDoc | undefined;
    if (!g || g.ownerUid !== uid) fail('NOT_FOUND', 'Group not found');
    await ref.delete();
    return { ok: true };
  }
}

/**
 * Turn roster input into stable PersonRefs for a session snapshot. Existing
 * personIds must be visible to the host; new names create guest people owned by
 * the host. The display name is snapshotted as typed for this night.
 */
export async function resolvePeopleForRoster(d: Deps, uid: string, roster: z.infer<typeof RosterEntry>[]): Promise<PersonRef[]> {
  const social = new SocialService(d);
  const out: PersonRef[] = [];
  const now = d.clock.now();
  const p = paths(d.db);
  for (const entry of roster) {
    if (entry.personId) {
      const person = await social.canSeePerson(uid, entry.personId);
      if (!person) fail('VALIDATION_FAILED', `Unknown person ${entry.displayName}`);
      const canonical = person!.mergedInto ?? person!.id;
      out.push({ personId: canonical, displayName: entry.displayName });
    } else {
      const ref = p.people().doc();
      const person: PersonDoc = { id: ref.id, displayName: entry.displayName, aliases: [], createdByUid: uid, linkedUid: null, isSelf: false, mergedInto: null, createdAt: now, updatedAt: now };
      await ref.create(person);
      out.push({ personId: ref.id, displayName: entry.displayName });
    }
  }
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.personId)) fail('VALIDATION_FAILED', `${r.displayName} is listed twice`);
    seen.add(r.personId);
  }
  return out;
}
