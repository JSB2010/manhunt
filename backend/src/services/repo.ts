import type { DocumentData, DocumentReference, Firestore, FirestoreDataConverter, Transaction } from 'firebase-admin/firestore';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { upgradeRoundDoc, upgradeSessionDoc } from '../domain/legacy.js';
import type { CaptureClaim, DomainEvent, MemberDoc, RoundDoc, SessionDoc } from '../domain/types.js';
import { renderView, viewHash } from '../domain/views.js';
import type { LiveActivityTransport } from './liveActivities.js';
import type { Notifier } from './notifier.js';
import type { Scheduler } from './scheduler.js';
import type { ObjectStore } from './storage.js';

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface Deps {
  cfg: Config;
  db: Firestore;
  store: ObjectStore;
  scheduler: Scheduler;
  notifier: Notifier;
  /** ActivityKit pushes for Live Activities (FCM when deployed) */
  liveActivityTransport: LiveActivityTransport;
  clock: Clock;
  log: FastifyBaseLogger;
  /** optional hook so the Firebase Auth admin API can be swapped in tests */
  deleteAuthUser?: (uid: string) => Promise<void>;
}

/** Reads nights recorded before crews in the current shape (domain/legacy.ts); writes are unchanged. */
const upgradeOnRead = (upgrade: (d: DocumentData) => DocumentData): FirestoreDataConverter<DocumentData, DocumentData> => ({
  toFirestore: (d: DocumentData) => d,
  fromFirestore: (snap) => upgrade(snap.data()),
});
const sessionReads = upgradeOnRead(upgradeSessionDoc);
const roundReads = upgradeOnRead(upgradeRoundDoc);

/**
 * Firestore layout. Everything except `sessions/{sid}/views/{uid}` is
 * server-only (firestore.rules denies all client access).
 */
export const paths = (db: Firestore) => ({
  user: (uid: string) => db.collection('users').doc(uid),
  devices: (uid: string) => db.collection('users').doc(uid).collection('devices'),
  handle: (h: string) => db.collection('handles').doc(h),
  session: (sid: string) => db.collection('sessions').withConverter(sessionReads).doc(sid),
  sessions: () => db.collection('sessions').withConverter(sessionReads),
  member: (sid: string, uid: string) => db.collection('sessions').doc(sid).collection('members').doc(uid),
  members: (sid: string) => db.collection('sessions').doc(sid).collection('members'),
  round: (sid: string, rid: string) => db.collection('sessions').doc(sid).collection('rounds').withConverter(roundReads).doc(rid),
  rounds: (sid: string) => db.collection('sessions').doc(sid).collection('rounds').withConverter(roundReads),
  points: (sid: string, rid: string) => db.collection('sessions').doc(sid).collection('rounds').doc(rid).collection('points'),
  pingDoc: (sid: string, rid: string, index: number) => db.collection('sessions').doc(sid).collection('rounds').doc(rid).collection('pings').doc(`p${index}`),
  claim: (sid: string, rid: string, cid: string) => db.collection('sessions').doc(sid).collection('rounds').doc(rid).collection('captures').doc(cid),
  claims: (sid: string, rid: string) => db.collection('sessions').doc(sid).collection('rounds').doc(rid).collection('captures'),
  events: (sid: string) => db.collection('sessions').doc(sid).collection('events'),
  view: (sid: string, uid: string) => db.collection('sessions').doc(sid).collection('views').doc(uid),
  summary: (sid: string, rid: string) => db.collection('sessions').doc(sid).collection('roundSummaries').doc(rid),
  route: (sid: string, rid: string) => db.collection('sessions').doc(sid).collection('routes').doc(rid),
  invites: () => db.collection('invites'),
  invite: (id: string) => db.collection('invites').doc(id),
  idempotency: (id: string) => db.collection('idempotency').doc(id),
  friendRequests: () => db.collection('friendRequests'),
  friendRequest: (id: string) => db.collection('friendRequests').doc(id),
  friendships: () => db.collection('friendships'),
  friendship: (id: string) => db.collection('friendships').doc(id),
  people: () => db.collection('people'),
  person: (id: string) => db.collection('people').doc(id),
  linkRequests: () => db.collection('personLinkRequests'),
  groups: () => db.collection('groups'),
  group: (id: string) => db.collection('groups').doc(id),
  friendTokens: (token: string) => db.collection('friendInviteTokens').doc(token),
});

export type Paths = ReturnType<typeof paths>;

export async function txGet<T>(tx: Transaction, ref: DocumentReference): Promise<T | null> {
  const snap = await tx.get(ref);
  return snap.exists ? (snap.data() as T) : null;
}

export async function txMembers(tx: Transaction, db: Firestore, sid: string): Promise<Record<string, MemberDoc>> {
  const snap = await tx.get(paths(db).members(sid));
  const out: Record<string, MemberDoc> = {};
  for (const d of snap.docs) out[d.id] = d.data() as MemberDoc;
  return out;
}

/**
 * Write each active member's sanitized view in the same transaction as the
 * state change — but only when its content changed (hash kept on the member
 * doc), so an unchanged view never reaches the phone. Updates `members` in
 * place with the new hashes and returns the uids whose member doc changed.
 * With `writeMembers: false` the caller writes those member docs itself
 * (a document may be written once per transaction here).
 */
export function writeViews(
  tx: Transaction,
  db: Firestore,
  session: SessionDoc,
  round: RoundDoc | null,
  members: Record<string, MemberDoc>,
  activeClaim: CaptureClaim | null,
  now: number,
  opts: { except?: Iterable<string> } = {},
): string[] {
  const p = paths(db);
  const except = new Set(opts.except ?? []);
  const changed: string[] = [];
  for (const m of Object.values(members)) {
    let hash: string | null = null;
    if (m.active) {
      const view = renderView({ uid: m.uid, session, round, members, activeClaim, now });
      hash = viewHash(view);
      if (hash !== m.viewHash) tx.set(p.view(session.id, m.uid), { ...view, viewHash: hash });
    } else if (m.viewHash !== null) {
      tx.delete(p.view(session.id, m.uid));
    }
    if (hash === (m.viewHash ?? null) && m.viewHash !== undefined) continue;
    members[m.uid] = { ...m, viewHash: hash };
    changed.push(m.uid);
    if (!except.has(m.uid)) tx.set(p.member(session.id, m.uid), { viewHash: hash }, { merge: true });
  }
  return changed;
}

export function writeEvents(tx: Transaction, db: Firestore, sessionId: string, events: DomainEvent[]) {
  const col = paths(db).events(sessionId);
  for (const e of events) tx.create(col.doc(), { ...e, sessionId });
}

export const newId = (db: Firestore) => db.collection('_ids').doc().id;
