import { createHash, randomInt } from 'node:crypto';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { effectiveChaseMs } from '../domain/clock.js';
import {
  abortRound,
  createRound,
  decideClaim,
  nextScheduledEvent,
  proposeDisputeResolution,
  refreshReadyRound,
  requestPause,
  setReady as engineSetReady,
  startRound as engineStartRound,
  submitClaim,
  suggestedHidingTeam,
  teamForUid,
  voteResume,
  type Transition,
} from '../domain/engine.js';
import { AppError, fail } from '../domain/errors.js';
import { isValidCoordinate } from '../domain/geo.js';
import { DEFAULT_RULES, mergeRules } from '../domain/rules.js';
import { tickRound } from '../domain/tick.js';
import {
  isActiveState,
  isFinishedState,
  otherTeam,
  type CaptureClaim,
  type DeviceHealth,
  type DomainEvent,
  type GpsPoint,
  type MemberDoc,
  type NotificationIntent,
  type PersonRef,
  type RoundDoc,
  type SessionDoc,
  type TeamKey,
} from '../domain/types.js';
import { renderView, type ViewDoc } from '../domain/views.js';
import type {
  AbortBody,
  ConsentBody,
  CreateSessionBody,
  HealthInput,
  LocationBatchBody,
  NextRoundBody,
  PauseBody,
  SetupPatchBody,
} from '../schemas/api.js';
import { finalizeRound } from './finalize.js';
import { paths, txGet, txMembers, writeEvents, writeViews, type Deps } from './repo.js';
import { stripJpegMetadata } from './storage.js';
import { resolvePeopleForRoster } from './socialService.js';

const TEAM_COLORS: Record<TeamKey, string> = { A: '#1E88E5', B: '#F4511E' };
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CONSENT_VERSION = 'v1';
/** Late uploads are accepted (for history only) this long after a round ends. */
const LATE_UPLOAD_WINDOW_MS = 30 * 60_000;
const RAW_POINT_RETENTION_MS = 30 * 24 * 3600_000;
const UPLOAD_TICKET_MS = 10 * 60_000;
const MAX_CLAIMS_PER_ROUND = 20;

export const hashCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export const emptyHealth = (): DeviceHealth => ({
  lastHeartbeatAt: null,
  lastSampleRecordedAt: null,
  lastSampleAccuracyMeters: null,
  permission: 'NOT_DETERMINED',
  preciseLocation: false,
  trackingActive: false,
  backgroundSessionActive: false,
  lowPowerMode: false,
  batteryLevel: null,
  networkReachable: true,
  appVersion: null,
  queuedSamples: 0,
});

function healthFrom(input: z.infer<typeof HealthInput>, prev: DeviceHealth, now: number, lastSample?: { recordedAt: number; accuracy: number }): DeviceHealth {
  return {
    lastHeartbeatAt: now,
    lastSampleRecordedAt:
      lastSample?.recordedAt ?? (input.lastFixAgeSeconds !== null ? now - input.lastFixAgeSeconds * 1000 : prev.lastSampleRecordedAt),
    lastSampleAccuracyMeters: lastSample?.accuracy ?? input.lastFixAccuracyMeters ?? prev.lastSampleAccuracyMeters,
    permission: input.permission,
    preciseLocation: input.preciseLocation,
    trackingActive: input.trackingActive,
    backgroundSessionActive: input.backgroundSessionActive,
    lowPowerMode: input.lowPowerMode,
    batteryLevel: input.batteryLevel,
    networkReachable: input.networkReachable,
    appVersion: input.appVersion,
    queuedSamples: input.queuedSamples,
  };
}

interface TxCtx {
  tx: Transaction;
  session: SessionDoc;
  round: RoundDoc;
  members: Record<string, MemberDoc>;
  claim: CaptureClaim | null;
  now: number;
}

interface TxOutcome<R> {
  result: R;
  session?: SessionDoc;
  round?: RoundDoc;
  claim?: CaptureClaim | null;
  members?: Record<string, MemberDoc>;
  events?: DomainEvent[];
  notifications?: NotificationIntent[];
  /** throw this after commit (e.g. expiry applied, then report CAPTURE_EXPIRED) */
  errorAfterCommit?: AppError;
}

export class GameService {
  private p;
  constructor(private d: Deps) {
    this.p = paths(d.db);
  }

  // -------------------------------------------------------------------------
  // Shared transaction plumbing
  // -------------------------------------------------------------------------

  private requireOperator(session: SessionDoc, members: Record<string, MemberDoc>, uid: string): TeamKey {
    const team = teamForUid(session, uid);
    if (!team || !members[uid]?.active) fail('OPERATOR_NOT_AUTHORIZED', 'You are not an operator in this session');
    return team!;
  }

  private onRoundFinished(session: SessionDoc, round: RoundDoc, now: number): SessionDoc {
    if (session.roundBriefs.some((b) => b.roundId === round.id) || !round.result) return session;
    const s = structuredClone(session);
    s.roundBriefs.push({
      roundId: round.id,
      index: round.index,
      hidingTeam: round.hidingTeam,
      outcome: round.result.outcome,
      observedChaseSeconds: round.result.observedChaseSeconds,
      isRightCensored: round.result.isRightCensored,
      rulesFingerprint: round.result.rulesFingerprint,
    });
    s.completedRoundCount = s.roundBriefs.length;
    s.status = s.roundBriefs.length >= s.rules.totalRounds ? 'COMPLETED' : 'BETWEEN_ROUNDS';
    s.updatedAt = now;
    s.version++;
    return s;
  }

  /**
   * Run a state change on the current round of a session inside a Firestore
   * transaction, then re-render every member's view in the same commit.
   */
  private async roundTx<R>(sid: string, rid: string | null, fn: (c: TxCtx) => Promise<TxOutcome<R>>): Promise<R> {
    const db = this.d.db;
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session) fail('NOT_FOUND', 'Session not found');
      if (session!.revokedAt) fail('GAME_CLOSED', 'This session was revoked');
      const roundId = rid ?? session!.currentRoundId;
      if (!roundId) fail('NOT_FOUND', 'No round in this session');
      if (rid && session!.currentRoundId !== rid && !session!.roundIds.includes(rid)) fail('NOT_FOUND', 'Round not found');
      const round = await txGet<RoundDoc>(tx, this.p.round(sid, roundId!));
      if (!round) fail('NOT_FOUND', 'Round not found');
      const members = await txMembers(tx, db, sid);
      const claim = round!.activeClaimId ? await txGet<CaptureClaim>(tx, this.p.claim(sid, roundId!, round!.activeClaimId)) : null;
      // A transaction on an earlier round (e.g. a stale worker wake-up for its
      // claim window) must still render views from the session's current round.
      const currentId = session!.currentRoundId;
      const current = currentId && currentId !== roundId ? await txGet<RoundDoc>(tx, this.p.round(sid, currentId)) : null;
      const currentClaim = current?.activeClaimId ? await txGet<CaptureClaim>(tx, this.p.claim(sid, current.id, current.activeClaimId)) : null;
      const ctx: TxCtx = { tx, session: session!, round: round!, members, claim, now };
      const o = await fn(ctx);

      let nextSession = o.session ?? session!;
      const nextRound = o.round ?? round!;
      if (o.round && isFinishedState(o.round.state) && !isFinishedState(round!.state)) {
        nextSession = this.onRoundFinished(nextSession, o.round, now);
      }
      const nextMembers = o.members ?? members;
      const nextClaim = o.claim !== undefined ? o.claim : claim;

      if (nextSession !== session) tx.set(this.p.session(sid), nextSession);
      if (o.round) {
        tx.set(this.p.round(sid, nextRound.id), nextRound);
        // Immutable per-index ping records: tx.create fails if one already exists,
        // so a duplicate release can never commit (spec §15.3 quality gate).
        for (const ping of nextRound.pings) {
          if (!round!.pings.some((x) => x.index === ping.index)) tx.create(this.p.pingDoc(sid, nextRound.id, ping.index), { ...ping, roundId: nextRound.id });
        }
      }
      if (o.claim) tx.set(this.p.claim(sid, nextRound.id, o.claim.claimId), o.claim);
      if (o.members) for (const m of Object.values(o.members)) tx.set(this.p.member(sid, m.uid), m);
      writeEvents(tx, db, sid, o.events ?? []);
      if (current && nextSession.currentRoundId === current.id) {
        writeViews(tx, db, nextSession, current, nextMembers, currentClaim, now);
      } else {
        const viewClaim = nextClaim && nextRound.activeClaimId === nextClaim.claimId ? nextClaim : null;
        writeViews(tx, db, nextSession, nextRound, nextMembers, viewClaim, now);
      }
      return { o, nextRound, roundChanged: !!o.round, wasFinished: isFinishedState(round!.state) };
    });
    await this.afterCommit(sid, out.nextRound, out.o.notifications ?? [], out.roundChanged && !out.wasFinished);
    if (out.o.errorAfterCommit) throw out.o.errorAfterCommit;
    return out.o.result;
  }

  private async afterCommit(sid: string, round: RoundDoc, notifications: NotificationIntent[], roundChanged: boolean) {
    if (notifications.length) {
      this.d.notifier.send(notifications).catch((err) => this.d.log.warn({ err }, 'notify failed'));
    }
    if (roundChanged && round.active) await this.scheduleNext(sid, round);
    if (roundChanged && isFinishedState(round.state)) {
      await finalizeRound(this.d, sid, round.id).catch((err) => this.d.log.error({ err, roundId: round.id }, 'finalize failed; watchdog will retry'));
    }
  }

  async scheduleNext(sid: string, round: RoundDoc) {
    const e = nextScheduledEvent(round);
    if (!e) return;
    const eventKey = `${e.kind.toLowerCase()}${e.kind === 'PING' ? e.pingIndex : ''}`;
    await this.d.scheduler.scheduleWake({ sessionId: sid, roundId: round.id, generation: round.phaseGeneration, eventKey, at: e.at });
  }

  // -------------------------------------------------------------------------
  // Session setup
  // -------------------------------------------------------------------------

  async createSession(uid: string, input: z.infer<typeof CreateSessionBody>): Promise<ViewDoc> {
    const db = this.d.db;
    const now = this.d.clock.now();
    const user = (await this.p.user(uid).get()).data();
    if (!user) fail('NOT_FOUND', 'Profile not found');
    const rules = mergeRules(DEFAULT_RULES, input.rules);
    const rosterA = await resolvePeopleForRoster(this.d, uid, input.teams.A.roster);
    const rosterB = await resolvePeopleForRoster(this.d, uid, input.teams.B.roster);
    this.assertDisjointRosters(rosterA, rosterB);
    const sid = this.p.sessions().doc().id;
    const rid = this.p.rounds(sid).doc().id;
    const mk = (k: TeamKey, roster: PersonRef[]) => ({
      teamId: this.p.sessions().doc().id,
      key: k,
      name: input.teams[k].name,
      color: input.teams[k].color ?? TEAM_COLORS[k],
      operatorUid: input.myTeam === k ? uid : null,
      operatorDisplayName: input.myTeam === k ? (user!.displayName as string) : null,
      roster,
    });
    const session: SessionDoc = {
      id: sid,
      title: input.title,
      scheduledDate: input.scheduledDate,
      hostUid: uid,
      status: 'LOBBY',
      rules,
      teams: { A: mk('A', rosterA), B: mk('B', rosterB) },
      memberUids: [uid],
      participantPersonIds: [...new Set([...rosterA, ...rosterB].map((p) => p.personId))],
      groupId: input.groupId ?? null,
      currentRoundId: rid,
      roundIds: [rid],
      completedRoundCount: 0,
      keepPhotos: { A: false, B: false },
      roundBriefs: [],
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    const member: MemberDoc = {
      uid,
      sessionId: sid,
      teamKey: input.myTeam,
      isHost: true,
      active: true,
      joinedAt: now,
      consent: null,
      consentRevokedAt: null,
      health: emptyHealth(),
      displayName: user!.displayName as string,
    };
    const first = suggestedHidingTeam(rules, 1, null);
    const t = createRound({ id: rid, session, index: 1, hidingTeam: first, suggestedHidingTeam: first, overrideByUid: null, overrideReason: null, now });
    const members = { [uid]: member };
    await db.runTransaction(async (tx) => {
      tx.create(this.p.session(sid), session);
      tx.create(this.p.member(sid, uid), member);
      tx.create(this.p.round(sid, rid), t.round);
      writeEvents(tx, db, sid, [{ type: 'SESSION_CREATED', at: now, actorUid: uid, roundId: null, details: { totalRounds: rules.totalRounds } }, ...t.events]);
      writeViews(tx, db, session, t.round, members, null, now);
    });
    return renderView({ uid, session, round: t.round, members, activeClaim: null, now });
  }

  private assertDisjointRosters(a: PersonRef[], b: PersonRef[]) {
    const ids = new Set(a.map((p) => p.personId));
    const dup = b.find((p) => ids.has(p.personId));
    if (dup) fail('VALIDATION_FAILED', `${dup.displayName} cannot be on both crews in the same night`);
  }

  async getView(uid: string, sid: string): Promise<ViewDoc> {
    const [sSnap, mSnap] = await Promise.all([this.p.session(sid).get(), this.p.members(sid).get()]);
    const session = sSnap.data() as SessionDoc | undefined;
    if (!session || !session.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    const members: Record<string, MemberDoc> = {};
    for (const d of mSnap.docs) members[d.id] = d.data() as MemberDoc;
    if (!members[uid]?.active) fail('NOT_FOUND', 'Session not found');
    const round = session!.currentRoundId ? ((await this.p.round(sid, session!.currentRoundId).get()).data() as RoundDoc | undefined) ?? null : null;
    const claim = round?.activeClaimId ? ((await this.p.claim(sid, round.id, round.activeClaimId).get()).data() as CaptureClaim | undefined) ?? null : null;
    return renderView({ uid, session: session!, round, members, activeClaim: claim, now: this.d.clock.now() });
  }

  async listSessions(uid: string, opts: { limit: number; q?: string | undefined; before?: number | undefined }) {
    let q = this.p.sessions().where('memberUids', 'array-contains', uid).orderBy('createdAt', 'desc');
    if (opts.before) q = q.where('createdAt', '<', opts.before);
    const snap = await q.limit(opts.q ? 200 : opts.limit).get();
    let items = snap.docs.map((d) => d.data() as SessionDoc).filter((s) => !s.revokedAt);
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      items = items.filter((s) =>
        [s.title, s.scheduledDate, s.teams.A.name, s.teams.B.name, ...s.teams.A.roster.map((p) => p.displayName), ...s.teams.B.roster.map((p) => p.displayName)]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      );
    }
    items = items.slice(0, opts.limit);
    return {
      items: items.map((s) => ({
        id: s.id,
        title: s.title,
        scheduledDate: s.scheduledDate,
        status: s.status,
        isHost: s.hostUid === uid,
        myTeam: teamForUid(s, uid),
        totalRounds: s.rules.totalRounds,
        completedRoundCount: s.completedRoundCount,
        teams: {
          A: { name: s.teams.A.name, color: s.teams.A.color, roster: s.teams.A.roster, operatorDisplayName: s.teams.A.operatorDisplayName },
          B: { name: s.teams.B.name, color: s.teams.B.color, roster: s.teams.B.roster, operatorDisplayName: s.teams.B.operatorDisplayName },
        },
        groupId: s.groupId,
        createdAt: new Date(s.createdAt).toISOString(),
      })),
      nextBefore: items.length === opts.limit ? items[items.length - 1]!.createdAt : null,
    };
  }

  async createInvite(uid: string, sid: string, input: { targetUid?: string | undefined }) {
    const now = this.d.clock.now();
    const sSnap = await this.p.session(sid).get();
    const session = sSnap.data() as SessionDoc | undefined;
    if (!session || !session.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    if (session!.hostUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the host can invite the second operator');
    if (session!.status === 'COMPLETED' || session!.revokedAt) fail('GAME_CLOSED', 'Session is closed');
    const openTeam: TeamKey | null = !session!.teams.A.operatorUid ? 'A' : !session!.teams.B.operatorUid ? 'B' : null;
    if (!openTeam) fail('CONFLICT', 'Both crews already have an operator');
    if (input.targetUid) {
      const fr = await this.p.friendship([uid, input.targetUid].sort().join('_')).get();
      if (!fr.exists || fr.get('blocked')) fail('FORBIDDEN', 'You can only directly invite accounts on your friends list');
    }
    // Revoke previous open invites for this session.
    const old = await this.p.invites().where('sessionId', '==', sid).where('revoked', '==', false).get();
    const code = Array.from({ length: 8 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');
    const ref = this.p.invites().doc();
    const expiresAt = now + this.d.cfg.inviteTtlMinutes * 60_000;
    const batch = this.d.db.batch();
    for (const d of old.docs) batch.update(d.ref, { revoked: true });
    batch.create(ref, {
      id: ref.id,
      codeHash: hashCode(code),
      sessionId: sid,
      sessionTitle: session!.title,
      teamKey: openTeam,
      teamName: session!.teams[openTeam!].name,
      hostDisplayName: session!.teams[otherTeam(openTeam!)].operatorDisplayName,
      targetUid: input.targetUid ?? null,
      createdByUid: uid,
      createdAt: now,
      expiresAt,
      expireAt: Timestamp.fromMillis(expiresAt + 24 * 3600_000),
      maxUses: 1,
      uses: 0,
      revoked: false,
    });
    await batch.commit();
    return {
      inviteId: ref.id,
      code,
      teamKey: openTeam,
      expiresAt: new Date(expiresAt).toISOString(),
      deepLink: `manhuntcrews://join?code=${code}`,
    };
  }

  async previewInvite(uid: string, code: string) {
    const snap = await this.p.invites().where('codeHash', '==', hashCode(code)).limit(1).get();
    const inv = snap.docs[0]?.data();
    const now = this.d.clock.now();
    if (!inv || inv.revoked || inv.expiresAt < now || inv.uses >= inv.maxUses || (inv.targetUid && inv.targetUid !== uid)) fail('INVITE_INVALID', 'Invite code is invalid or expired');
    const session = (await this.p.session(inv!.sessionId).get()).data() as SessionDoc;
    return {
      sessionId: session.id,
      title: session.title,
      scheduledDate: session.scheduledDate,
      teamKey: inv!.teamKey as TeamKey,
      teams: { A: { name: session.teams.A.name, roster: session.teams.A.roster }, B: { name: session.teams.B.name, roster: session.teams.B.roster } },
      hostDisplayName: inv!.hostDisplayName as string | null,
      rules: session.rules,
      expiresAt: new Date(inv!.expiresAt).toISOString(),
    };
  }

  async redeemInvite(uid: string, input: { code?: string | undefined; inviteId?: string | undefined }): Promise<ViewDoc> {
    const db = this.d.db;
    const user = (await this.p.user(uid).get()).data();
    if (!user) fail('NOT_FOUND', 'Profile not found');
    const result = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      let invRef;
      if (input.code) {
        const q = await tx.get(this.p.invites().where('codeHash', '==', hashCode(input.code)).limit(1));
        invRef = q.docs[0]?.ref;
      } else invRef = this.p.invite(input.inviteId!);
      const inv = invRef ? (await tx.get(invRef)).data() : undefined;
      if (!inv || inv.revoked || inv.expiresAt < now || inv.uses >= inv.maxUses) fail('INVITE_INVALID', 'Invite code is invalid or expired');
      if (inv!.targetUid && inv!.targetUid !== uid) fail('INVITE_INVALID', 'This invite was issued to a different account');
      const session = await txGet<SessionDoc>(tx, this.p.session(inv!.sessionId));
      if (!session || session.revokedAt || session.status === 'COMPLETED') fail('GAME_CLOSED', 'Session is closed');
      const members = await txMembers(tx, db, session!.id);
      const round = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(session!.id, session!.currentRoundId)) : null;
      const teamKey = inv!.teamKey as TeamKey;
      if (session!.memberUids.includes(uid) || teamForUid(session!, uid)) fail('CONFLICT', 'You already operate a crew in this session');
      if (session!.teams[teamKey].operatorUid) fail('CONFLICT', 'That crew already has an operator');
      const s = structuredClone(session!);
      s.teams[teamKey].operatorUid = uid;
      s.teams[teamKey].operatorDisplayName = user!.displayName as string;
      // The operator travels with their crew; add their own person record if missing.
      const selfPersonId = user!.selfPersonId as string | undefined;
      if (selfPersonId && !s.teams[teamKey].roster.some((r) => r.personId === selfPersonId) && !s.teams[otherTeam(teamKey)].roster.some((r) => r.personId === selfPersonId)) {
        s.teams[teamKey].roster.push({ personId: selfPersonId, displayName: user!.displayName as string });
        s.participantPersonIds = [...new Set([...s.participantPersonIds, selfPersonId])];
      }
      s.memberUids = [...s.memberUids, uid];
      s.updatedAt = now;
      s.version++;
      const member: MemberDoc = {
        uid,
        sessionId: s.id,
        teamKey,
        isHost: false,
        active: true,
        joinedAt: now,
        consent: null,
        consentRevokedAt: null,
        health: emptyHealth(),
        displayName: user!.displayName as string,
      };
      const nextMembers = { ...members, [uid]: member };
      let r = round;
      if (r && r.state === 'READY') {
        r = refreshReadyRound(r, s, now);
        tx.set(this.p.round(s.id, r.id), r);
      }
      tx.update(invRef!, { uses: inv!.uses + 1, redeemedByUid: uid, redeemedAt: now });
      tx.set(this.p.session(s.id), s);
      tx.create(this.p.member(s.id, uid), member);
      writeEvents(tx, db, s.id, [{ type: 'OPERATOR_JOINED', at: now, actorUid: uid, roundId: null, details: { team: teamKey } }]);
      writeViews(tx, db, s, r, nextMembers, null, now);
      return { view: renderView({ uid, session: s, round: r, members: nextMembers, activeClaim: null, now }), hostUid: s.hostUid, sid: s.id, teamName: s.teams[teamKey].name };
    });
    this.d.notifier
      .send([{ toUids: [result.hostUid], kind: 'OPERATOR_JOINED', title: 'Operator joined', body: `${user!.displayName as string} joined as ${result.teamName}'s operator.`, sessionId: result.sid, roundId: null }])
      .catch(() => undefined);
    return result.view;
  }

  async setConsent(uid: string, sid: string, input: z.infer<typeof ConsentBody>) {
    return this.roundTx(sid, null, async ({ session, round, members, now }) => {
      const team = this.requireOperator(session, members, uid);
      const m = structuredClone(members[uid]!);
      const events: DomainEvent[] = [];
      let r: RoundDoc | undefined;
      let notifications: NotificationIntent[] = [];
      if (input.accepted) {
        if (!input.routeSharingAfterRound || !input.guestDisclosureAcknowledged) {
          fail('CONSENT_REQUIRED', 'Route sharing after each round and the guest disclosure must be acknowledged to play');
        }
        m.consent = { acceptedAt: now, version: input.consentVersion, routeSharingAfterRound: true, guestDisclosureAcknowledged: true };
        m.consentRevokedAt = null;
        events.push({ type: 'CONSENT_GIVEN', at: now, actorUid: uid, roundId: null, details: { team, version: input.consentVersion } });
      } else {
        m.consentRevokedAt = now;
        events.push({ type: 'CONSENT_REVOKED', at: now, actorUid: uid, roundId: round.id, details: { team } });
        if (isActiveState(round.state)) {
          const t = abortRound(round, uid, 'Tracking consent withdrawn by an operator', now);
          r = t.round;
          events.push(...t.events);
          notifications = t.notifications;
        } else if (round.state === 'READY' && round.ready[team]) {
          r = engineSetReady(round, team, uid, false, now).round;
        }
      }
      return { result: { ok: true }, members: { ...members, [uid]: m }, ...(r ? { round: r } : {}), events, notifications };
    });
  }

  async setReady(uid: string, sid: string, ready: boolean, preflight: z.infer<typeof HealthInput>) {
    return this.roundTx(sid, null, async ({ session, round, members, now }) => {
      const team = this.requireOperator(session, members, uid);
      const m = structuredClone(members[uid]!);
      if (ready && (!m.consent || m.consentRevokedAt)) fail('CONSENT_REQUIRED', 'Accept the tracking and route disclosure first');
      if (!session.teams.A.operatorUid || !session.teams.B.operatorUid) {
        if (ready) fail('GAME_NOT_READY', 'Waiting for the second operator to join');
      }
      m.health = healthFrom(preflight, m.health, now);
      const t = engineSetReady(round, team, uid, ready, now);
      return { result: { ok: true }, round: t.round, members: { ...members, [uid]: m }, events: t.events, notifications: t.notifications };
    });
  }

  async editSetup(uid: string, sid: string, patch: z.infer<typeof SetupPatchBody>) {
    return this.roundTx(sid, null, async ({ session, round, now }) => {
      if (session.hostUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the host can edit setup');
      if (round.state !== 'READY' && !isFinishedState(round.state)) fail('GAME_CLOSED', 'Setup cannot change during a round');
      if (session.status === 'COMPLETED') fail('GAME_CLOSED', 'Session is complete');
      const s = structuredClone(session);
      if (patch.title) s.title = patch.title;
      if (patch.scheduledDate) s.scheduledDate = patch.scheduledDate;
      if (patch.rules) {
        const merged = mergeRules(s.rules, patch.rules);
        if (merged.totalRounds < s.roundBriefs.length + (round.state === 'READY' ? 1 : 0)) fail('VALIDATION_FAILED', 'Total rounds cannot be below rounds already played');
        if (s.roundBriefs.length > 0 && merged.initialHidingTeam !== s.rules.initialHidingTeam) fail('VALIDATION_FAILED', 'First hiding crew is fixed after round 1');
        s.rules = merged;
      }
      for (const k of ['A', 'B'] as const) {
        const tp = patch.teams?.[k];
        if (!tp) continue;
        if (tp.name) s.teams[k].name = tp.name;
        if (tp.color) s.teams[k].color = tp.color;
        if (tp.roster) s.teams[k].roster = await resolvePeopleForRoster(this.d, uid, tp.roster);
      }
      this.assertDisjointRosters(s.teams.A.roster, s.teams.B.roster);
      s.participantPersonIds = [...new Set([...s.participantPersonIds, ...s.teams.A.roster.map((p) => p.personId), ...s.teams.B.roster.map((p) => p.personId)])];
      s.updatedAt = now;
      s.version++;
      let r: RoundDoc | undefined;
      if (round.state === 'READY') {
        r = refreshReadyRound(round, s, now);
        // Changing the first-round hider before round 1 starts re-derives the suggestion.
        if (round.index === 1 && patch.rules?.initialHidingTeam) {
          r.hidingTeam = s.rules.initialHidingTeam;
          r.seekingTeam = otherTeam(r.hidingTeam);
        }
      }
      return {
        result: { ok: true },
        session: s,
        ...(r ? { round: r } : {}),
        events: [{ type: 'SETUP_EDITED', at: now, actorUid: uid, roundId: round.id, details: { fields: Object.keys(patch).join(',') } }],
      };
    });
  }

  /** Preflight checks run at start (spec §3.2 READY → HEAD_START). */
  private startWarnings(session: SessionDoc, round: RoundDoc, members: Record<string, MemberDoc>, now: number) {
    const blocking: string[] = [];
    const warnings: string[] = [];
    for (const team of ['A', 'B'] as const) {
      const uid = session.teams[team].operatorUid!;
      const role = team === round.hidingTeam ? 'HIDER' : 'SEEKER';
      const m = members[uid];
      if (!m?.consent || m.consentRevokedAt) blocking.push(`${role}_CONSENT_MISSING`);
      const h = m?.health;
      if (!h) continue;
      if (h.permission === 'DENIED' || h.permission === 'RESTRICTED' || h.permission === 'NOT_DETERMINED') blocking.push(`${role}_LOCATION_PERMISSION_DENIED`);
      if (!h.preciseLocation) warnings.push(`${role}_PRECISE_LOCATION_OFF`);
      if (h.lastHeartbeatAt === null || now - h.lastHeartbeatAt > 120_000) warnings.push(`${role}_OFFLINE`);
      if (h.lastSampleRecordedAt === null || now - h.lastSampleRecordedAt > 120_000) warnings.push(`${role}_GPS_STALE`);
      if (h.lastSampleAccuracyMeters !== null && h.lastSampleAccuracyMeters > round.rules.maxPingAccuracyMeters) warnings.push(`${role}_GPS_INACCURATE`);
      if (h.lowPowerMode) warnings.push(`${role}_LOW_POWER_MODE`);
    }
    return { blocking, warnings };
  }

  async startRound(uid: string, sid: string, rid: string, acknowledgeWarnings: boolean) {
    return this.roundTx(sid, rid, async ({ session, round, members, now }) => {
      this.requireOperator(session, members, uid);
      if (round.id !== session.currentRoundId) fail('STALE_PHASE', 'Not the current round');
      if (round.state === 'READY' && (!round.ready.A || !round.ready.B)) fail('GAME_NOT_READY', 'Both operators must tap Ready');
      const { blocking, warnings } = this.startWarnings(session, round, members, now);
      if (blocking.length) fail('PERMISSION_REQUIRED', 'Round cannot start until both operators fix these issues', { blocking, warnings });
      if (warnings.length && !acknowledgeWarnings) fail('GPS_UNAVAILABLE', 'Location health warnings must be acknowledged to start', { warnings });
      const t: Transition = engineStartRound(round, session, uid, warnings, now);
      const s = { ...structuredClone(session), status: 'IN_ROUND' as const, updatedAt: now, version: session.version + 1 };
      return { result: { ok: true, warnings }, session: s, round: t.round, events: t.events, notifications: t.notifications };
    });
  }

  // -------------------------------------------------------------------------
  // Worker tick (task-queue function / watchdog)
  // -------------------------------------------------------------------------

  async tick(sid: string, rid: string) {
    return this.roundTx(sid, rid, async ({ tx, round, claim, now }) => {
      if (!isActiveState(round.state)) return { result: { processed: [] as unknown[] } };
      const r = await tickRound(round, now, {
        activeClaim: claim,
        candidatesForDeadline: async (deadline, maxAgeSeconds) => {
          if (!round.hiderUid) return [];
          const q = this.p
            .points(sid, rid)
            .where('operatorUid', '==', round.hiderUid)
            .where('recordedAt', '>=', deadline - maxAgeSeconds * 1000)
            .where('recordedAt', '<=', deadline)
            .orderBy('recordedAt', 'desc')
            .limit(100);
          const snap = await tx.get(q);
          return snap.docs.map((d) => d.data() as GpsPoint);
        },
      });
      if (!r.processed.length) return { result: { processed: [] as unknown[] } };
      let claimOut: CaptureClaim | null | undefined;
      if (r.claimExpired) claimOut = { ...r.claimExpired, status: 'EXPIRED', reviewedAt: now };
      return { result: { processed: r.processed as unknown[] }, round: r.round, events: r.events, notifications: r.notifications, ...(claimOut ? { claim: claimOut } : {}) };
    });
  }

  // -------------------------------------------------------------------------
  // Private telemetry
  // -------------------------------------------------------------------------

  async ingestLocations(uid: string, sid: string, rid: string, body: z.infer<typeof LocationBatchBody>) {
    const now = this.d.clock.now();
    const [sSnap, rSnap] = await Promise.all([this.p.session(sid).get(), this.p.round(sid, rid).get()]);
    const session = sSnap.data() as SessionDoc | undefined;
    const round = rSnap.data() as RoundDoc | undefined;
    if (!session || !round || !session.memberUids.includes(uid)) fail('NOT_FOUND', 'Round not found');
    const team = teamForUid(session!, uid);
    if (!team) fail('OPERATOR_NOT_AUTHORIZED', 'Not an operator');
    if (round!.state === 'READY' || round!.roundStartAt === null) fail('GAME_NOT_READY', 'Round has not started; tracking samples are not accepted yet');
    // Role is derived from the round snapshot — never from the request.
    if (uid !== round!.hiderUid && uid !== round!.seekerUid) fail('OPERATOR_NOT_AUTHORIZED', 'Not an operator in this round');
    const finished = isFinishedState(round!.state);
    if (finished && round!.endedAt !== null && now - round!.endedAt > LATE_UPLOAD_WINDOW_MS) fail('GAME_CLOSED', 'Round closed for uploads');
    const role = uid === round!.hiderUid ? 'HIDING' : 'SEEKING';

    const sentAt = Date.parse(body.sentAt);
    const skew = now - sentAt; // positive: device clock behind server
    const skewFlags: string[] = [];
    let correction = 0;
    if (Math.abs(skew) > 3600_000) skewFlags.push('CLOCK_UNTRUSTED');
    else if (Math.abs(skew) > 2_000) {
      correction = skew;
      skewFlags.push('CLOCK_CORRECTED');
    }

    const officialEnd = round!.result?.officialFoundAt ?? round!.endedAt;
    const rejected: { pointId: string; reason: string }[] = [];
    const candidates: GpsPoint[] = [];
    for (const s of body.samples) {
      const deviceRecordedAt = Date.parse(s.recordedAt);
      const recordedAt = deviceRecordedAt + correction;
      const flags = [...skewFlags];
      if (!isValidCoordinate(s.latitude, s.longitude)) {
        rejected.push({ pointId: s.pointId, reason: 'INVALID_COORDINATE' });
        continue;
      }
      if (recordedAt < round!.roundStartAt! - 10_000) {
        rejected.push({ pointId: s.pointId, reason: 'BEFORE_ROUND' });
        continue;
      }
      if (finished && round!.endedAt !== null && recordedAt > round!.endedAt + 5_000) {
        rejected.push({ pointId: s.pointId, reason: 'AFTER_ROUND' });
        continue;
      }
      if (recordedAt > now + 5_000) flags.push('FUTURE_TIMESTAMP');
      if (s.horizontalAccuracyMeters > round!.rules.maxPingAccuracyMeters) flags.push('LOW_ACCURACY');
      if (now - recordedAt > 120_000) flags.push('LATE_UPLOAD');
      if (officialEnd !== null && recordedAt > officialEnd) flags.push('AFTER_OFFICIAL_END');
      candidates.push({
        pointId: s.pointId,
        sessionId: sid,
        roundId: rid,
        operatorUid: uid,
        teamKey: team!,
        role,
        recordedAt,
        deviceRecordedAt,
        receivedAt: now,
        latitude: s.latitude,
        longitude: s.longitude,
        horizontalAccuracyMeters: s.horizontalAccuracyMeters,
        speedMetersPerSecond: s.speedMetersPerSecond ?? null,
        courseDegrees: s.courseDegrees ?? null,
        qualityFlags: flags,
        batchId: body.batchId,
      });
    }

    // Idempotent insert: existing pointIds are skipped (first receipt time wins).
    let duplicates = 0;
    const refs = candidates.map((c) => this.p.points(sid, rid).doc(c.pointId));
    for (let i = 0; i < refs.length; i += 200) {
      const chunk = refs.slice(i, i + 200);
      const snaps = chunk.length ? await this.d.db.getAll(...chunk) : [];
      const batch = this.d.db.batch();
      snaps.forEach((snap, j) => {
        if (snap.exists) {
          duplicates++;
          return;
        }
        const c = candidates[i + j]!;
        batch.create(snap.ref, { ...c, expireAt: Timestamp.fromMillis(c.recordedAt + RAW_POINT_RETENTION_MS) });
      });
      await batch.commit();
    }

    const newest = candidates.filter((c) => !c.qualityFlags.includes('FUTURE_TIMESTAMP')).sort((a, b) => b.recordedAt - a.recordedAt)[0];
    await this.updateHealth(uid, sid, body.health, now, newest ? { recordedAt: newest.recordedAt, accuracy: newest.horizontalAccuracyMeters } : undefined);
    if (finished && candidates.length - duplicates > 0) {
      await finalizeRound(this.d, sid, rid, { force: true }).catch((err) => this.d.log.warn({ err }, 're-finalize after late upload failed'));
    }
    return { accepted: candidates.length - duplicates, duplicates, rejected, clockSkewMs: skew, serverTime: new Date(now).toISOString() };
  }

  /** Health heartbeat. Views are re-rendered transactionally only when visible health changes. */
  private async updateHealth(uid: string, sid: string, input: z.infer<typeof HealthInput>, now: number, lastSample?: { recordedAt: number; accuracy: number }) {
    await this.roundTx(sid, null, async ({ members }) => {
      const m = members[uid];
      if (!m) return { result: null };
      const next = { ...structuredClone(m), health: healthFrom(input, m.health, now, lastSample) };
      return { result: null, members: { ...members, [uid]: next } };
    });
  }

  async myTrack(uid: string, sid: string, rid: string) {
    const round = (await this.p.round(sid, rid).get()).data() as RoundDoc | undefined;
    if (!round || (round.hiderUid !== uid && round.seekerUid !== uid)) fail('NOT_FOUND', 'Round not found');
    // Self-only: filter by the caller's own operator uid.
    const snap = await this.p.points(sid, rid).where('operatorUid', '==', uid).orderBy('recordedAt', 'asc').limit(5000).get();
    return {
      points: snap.docs.map((d) => {
        const p = d.data() as GpsPoint;
        return { pointId: p.pointId, recordedAt: new Date(p.recordedAt).toISOString(), latitude: p.latitude, longitude: p.longitude, horizontalAccuracyMeters: p.horizontalAccuracyMeters };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Capture claims
  // -------------------------------------------------------------------------

  async captureInit(uid: string, sid: string, rid: string) {
    const now = this.d.clock.now();
    const round = (await this.p.round(sid, rid).get()).data() as RoundDoc | undefined;
    if (!round) fail('NOT_FOUND', 'Round not found');
    if (uid !== round!.seekerUid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the seeking operator can capture');
    if (round!.state === 'CAPTURE_PENDING') fail('ALREADY_CLAIMED', 'A claim is already awaiting confirmation');
    if (round!.state !== 'CHASE') fail('STALE_PHASE', 'Catches can be claimed only during the chase');
    const existing = await this.p.claims(sid, rid).where('seekerUid', '==', uid).count().get();
    if (existing.data().count >= MAX_CLAIMS_PER_ROUND) fail('RATE_LIMITED', 'Too many claims this round');
    const ref = this.p.claims(sid, rid).doc();
    const claim: CaptureClaim = {
      claimId: ref.id,
      sessionId: sid,
      roundId: rid,
      seekerUid: uid,
      seekerTeam: round!.seekingTeam,
      status: 'UPLOADING',
      createdAt: now,
      uploadExpiresAt: now + UPLOAD_TICKET_MS,
      imageObjectKey: `sessions/${sid}/rounds/${rid}/captures/${ref.id}.jpg`,
      photoStoredAt: null,
      photoSha256: null,
      photoBytes: null,
      submittedAt: null,
      expiresAt: null,
      officialChaseMsAtClaim: null,
      reviewedByUid: null,
      reviewedAt: null,
      rejectionReason: null,
      photoDeletedAt: null,
      dispute: null,
    };
    await ref.create(claim);
    return {
      claimId: claim.claimId,
      uploadPath: `/v1/sessions/${sid}/rounds/${rid}/captures/${claim.claimId}/photo`,
      uploadMethod: 'PUT',
      contentType: 'image/jpeg',
      maxBytes: this.d.cfg.maxPhotoBytes,
      expiresAt: new Date(claim.uploadExpiresAt).toISOString(),
    };
  }

  async capturePhoto(uid: string, sid: string, rid: string, cid: string, bytes: Buffer) {
    const now = this.d.clock.now();
    const ref = this.p.claim(sid, rid, cid);
    const claim = (await ref.get()).data() as CaptureClaim | undefined;
    if (!claim || claim.seekerUid !== uid) fail('NOT_FOUND', 'Upload ticket not found');
    if (claim!.status !== 'UPLOADING') fail('CONFLICT', 'Photo already submitted for this claim');
    if (now > claim!.uploadExpiresAt) fail('CAPTURE_EXPIRED', 'Upload ticket expired; start a new capture');
    if (bytes.length === 0 || bytes.length > this.d.cfg.maxPhotoBytes) fail('PAYLOAD_TOO_LARGE', 'Photo is empty or too large');
    let clean: Buffer;
    try {
      clean = stripJpegMetadata(bytes);
    } catch {
      return fail('UNSUPPORTED_MEDIA', 'Photo must be a JPEG image');
    }
    const sha = createHash('sha256').update(clean).digest('hex');
    await this.d.store.put(claim!.imageObjectKey, clean, 'image/jpeg', { claimId: cid });
    await ref.update({ photoStoredAt: now, photoSha256: sha, photoBytes: clean.length });
    return { claimId: cid, stored: true, bytes: clean.length, sha256: sha };
  }

  async captureComplete(uid: string, sid: string, rid: string, cid: string) {
    return this.roundTx(sid, rid, async ({ tx, round, now }) => {
      const claim = await txGet<CaptureClaim>(tx, this.p.claim(sid, rid, cid));
      if (!claim || claim.seekerUid !== uid) fail('NOT_FOUND', 'Claim not found');
      if (claim!.status === 'PENDING' && round.activeClaimId === cid) {
        return { result: { claimId: cid, status: 'PENDING', submittedAt: new Date(claim!.submittedAt!).toISOString() } };
      }
      if (claim!.status !== 'UPLOADING') fail('CONFLICT', `Claim is ${claim!.status}`);
      if (!claim!.photoStoredAt) fail('GAME_NOT_READY', 'Photo upload has not completed');
      const t = submitClaim(round, claim!, uid, now);
      const submitted: CaptureClaim = {
        ...claim!,
        status: 'PENDING',
        submittedAt: now,
        expiresAt: t.round.claimExpiresAt,
        officialChaseMsAtClaim: effectiveChaseMs(t.round, now),
      };
      return {
        result: { claimId: cid, status: 'PENDING', submittedAt: new Date(now).toISOString() },
        round: t.round,
        claim: submitted,
        events: t.events,
        notifications: t.notifications,
      };
    });
  }

  async captureDecision(uid: string, sid: string, rid: string, cid: string, decision: 'CONFIRM' | 'REJECT', reason: string | null) {
    return this.roundTx(sid, rid, async ({ tx, round, claim, now }) => {
      const c = claim?.claimId === cid ? claim : await txGet<CaptureClaim>(tx, this.p.claim(sid, rid, cid));
      if (!c) fail('NOT_FOUND', 'Claim not found');
      // Apply any due expiry first so a late decision can never override it.
      if (round.state === 'CAPTURE_PENDING' && round.claimExpiresAt !== null && now > round.claimExpiresAt && round.activeClaimId === cid) {
        const r = await tickRound(round, now, { activeClaim: c, candidatesForDeadline: async () => [] });
        return {
          result: null,
          round: r.round,
          claim: { ...c!, status: 'EXPIRED' as const, reviewedAt: now },
          events: r.events,
          notifications: r.notifications,
          errorAfterCommit: new AppError('CAPTURE_EXPIRED', 'Confirmation window expired; the round resumed'),
        };
      }
      const t = decideClaim(round, c!, uid, decision, reason, now);
      const updated: CaptureClaim = {
        ...c!,
        status: decision === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED',
        reviewedByUid: uid,
        reviewedAt: now,
        rejectionReason: decision === 'REJECT' ? reason : null,
      };
      return {
        result: { claimId: cid, status: updated.status, roundState: t.round.state, result: t.round.result },
        round: t.round,
        claim: updated,
        events: t.events,
        notifications: t.notifications,
      };
    });
  }

  async getCapturePhoto(uid: string, sid: string, rid: string, cid: string): Promise<Buffer> {
    const [round, claim] = await Promise.all([
      this.p.round(sid, rid).get().then((s) => s.data() as RoundDoc | undefined),
      this.p.claim(sid, rid, cid).get().then((s) => s.data() as CaptureClaim | undefined),
    ]);
    if (!round || !claim || claim.photoDeletedAt) fail('NOT_FOUND', 'Photo not found');
    const isOperator = uid === round!.hiderUid || uid === round!.seekerUid;
    if (!isOperator) fail('NOT_FOUND', 'Photo not found');
    if (claim!.status === 'UPLOADING' && claim!.seekerUid !== uid) fail('NOT_FOUND', 'Photo not found');
    const bytes = await this.d.store.get(claim!.imageObjectKey);
    if (!bytes) fail('NOT_FOUND', 'Photo not found');
    return bytes!;
  }

  // -------------------------------------------------------------------------
  // Pause / resume / abort / disputes
  // -------------------------------------------------------------------------

  async pause(uid: string, sid: string, rid: string, body: z.infer<typeof PauseBody>) {
    return this.roundTx(sid, rid, async ({ session, round, members, now }) => {
      const team = this.requireOperator(session, members, uid);
      const t = requestPause(round, uid, team, body.kind, body.reason ?? null, now);
      return { result: { state: t.round.state, pendingRequest: !!t.round.pendingPauseRequest }, round: t.round, events: t.events, notifications: t.notifications };
    });
  }

  async resume(uid: string, sid: string, rid: string) {
    return this.roundTx(sid, rid, async ({ session, round, members, now }) => {
      const team = this.requireOperator(session, members, uid);
      const t = voteResume(round, uid, team, now);
      return { result: { state: t.round.state }, round: t.round, events: t.events, notifications: t.notifications };
    });
  }

  async abort(uid: string, sid: string, rid: string, body: z.infer<typeof AbortBody>) {
    return this.roundTx(sid, rid, async ({ session, round, members, claim, now }) => {
      this.requireOperator(session, members, uid);
      const t = abortRound(round, uid, `${body.safety ? 'Safety: ' : ''}${body.reason}`, now);
      const c = claim && claim.status === 'PENDING' ? { ...claim, status: 'ABANDONED' as const } : undefined;
      return { result: { state: t.round.state }, round: t.round, events: t.events, notifications: t.notifications, ...(c ? { claim: c } : {}) };
    });
  }

  async resolveDispute(uid: string, sid: string, rid: string, cid: string, resolution: 'ACCEPT_AS_CATCH' | 'KEEP_REJECTED') {
    const out = await this.d.db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      const round = await txGet<RoundDoc>(tx, this.p.round(sid, rid));
      const claim = await txGet<CaptureClaim>(tx, this.p.claim(sid, rid, cid));
      if (!session || !round || !claim) fail('NOT_FOUND', 'Not found');
      const members = await txMembers(tx, this.d.db, sid);
      // All reads before any write (Firestore transaction rule).
      const otherCurrent = session!.currentRoundId && session!.currentRoundId !== rid ? await txGet<RoundDoc>(tx, this.p.round(sid, session!.currentRoundId)) : null;
      const otherClaim = otherCurrent?.activeClaimId ? await txGet<CaptureClaim>(tx, this.p.claim(sid, otherCurrent.id, otherCurrent.activeClaimId)) : null;
      const team = this.requireOperator(session!, members, uid);
      const r = proposeDisputeResolution(round!, claim!, uid, team, resolution, now);
      tx.set(this.p.claim(sid, rid, cid), r.claim);
      writeEvents(tx, this.d.db, sid, r.events);
      if (r.resolved && r.round.result) {
        tx.set(this.p.round(sid, rid), r.round);
        const s = structuredClone(session!);
        const brief = s.roundBriefs.find((b) => b.roundId === rid);
        if (brief) {
          brief.outcome = r.round.result.outcome;
          brief.observedChaseSeconds = r.round.result.observedChaseSeconds;
          brief.isRightCensored = r.round.result.isRightCensored;
          s.version++;
          s.updatedAt = now;
          tx.set(this.p.session(sid), s);
        }
        writeViews(tx, this.d.db, s, otherCurrent ?? r.round, members, otherCurrent ? otherClaim : null, now);
      }
      return { resolved: r.resolved, resolution: r.claim.dispute?.resolution ?? null };
    });
    if (out.resolved) await finalizeRound(this.d, sid, rid, { force: true }).catch(() => undefined);
    return out;
  }

  // -------------------------------------------------------------------------
  // Multi-round flow
  // -------------------------------------------------------------------------

  async nextRound(uid: string, sid: string, body: z.infer<typeof NextRoundBody>) {
    const db = this.d.db;
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session) fail('NOT_FOUND', 'Session not found');
      if (session!.hostUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the host can set up the next round');
      const current = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(sid, session!.currentRoundId)) : null;
      const members = await txMembers(tx, db, sid);
      if (current && !isFinishedState(current.state)) {
        if (current.state === 'READY') return { round: current, session: session!, members, created: false };
        fail('STALE_PHASE', 'Finish the current round first');
      }
      if (session!.status === 'COMPLETED') fail('GAME_CLOSED', 'The night is complete');
      if (session!.roundBriefs.length >= session!.rules.totalRounds) fail('GAME_CLOSED', 'All planned rounds are played');
      const index = session!.roundIds.length + 1;
      const suggestion = suggestedHidingTeam(session!.rules, index, current?.hidingTeam ?? null);
      const hidingTeam = body.hidingTeam ?? suggestion;
      const rid = this.p.rounds(sid).doc().id;
      const t = createRound({ id: rid, session: session!, index, hidingTeam, suggestedHidingTeam: suggestion, overrideByUid: uid, overrideReason: body.overrideReason ?? null, now });
      const s = structuredClone(session!);
      s.currentRoundId = rid;
      s.roundIds.push(rid);
      s.status = 'BETWEEN_ROUNDS';
      s.updatedAt = now;
      s.version++;
      tx.create(this.p.round(sid, rid), t.round);
      tx.set(this.p.session(sid), s);
      writeEvents(tx, db, sid, t.events);
      writeViews(tx, db, s, t.round, members, null, now);
      return { round: t.round, session: s, members, created: true, notifications: t.notifications };
    });
    if (out.created && out.notifications) this.d.notifier.send(out.notifications).catch(() => undefined);
    return renderView({ uid, session: out.session, round: out.round, members: out.members, activeClaim: null, now: this.d.clock.now() });
  }

  async completeSession(uid: string, sid: string) {
    return this.roundTx(sid, null, async ({ session, round, now }) => {
      if (session.hostUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the host can end the night');
      if (isActiveState(round.state)) fail('STALE_PHASE', 'Finish or abort the current round first');
      const s = { ...structuredClone(session), status: 'COMPLETED' as const, updatedAt: now, version: session.version + 1 };
      return {
        result: { ok: true },
        session: s,
        events: [{ type: 'SESSION_COMPLETED' as const, at: now, actorUid: uid, roundId: null, details: { rounds: s.roundBriefs.length } }],
        notifications: [{ toUids: s.memberUids, kind: 'SESSION_COMPLETED', title: 'Night complete', body: `${s.title}: scorecard is ready.`, sessionId: sid, roundId: null }],
      };
    });
  }

  async setKeepPhotos(uid: string, sid: string, keep: boolean) {
    return this.roundTx(sid, null, async ({ session, members, now }) => {
      const team = this.requireOperator(session, members, uid);
      const s = structuredClone(session);
      s.keepPhotos[team] = keep;
      s.updatedAt = now;
      s.version++;
      return { result: { keepPhotos: s.keepPhotos }, session: s };
    });
  }

  // -------------------------------------------------------------------------
  // Watchdog (scheduled function, ~1/min): repair missing wake-ups and summaries
  // -------------------------------------------------------------------------

  async watchdog() {
    const now = this.d.clock.now();
    const active = await this.d.db.collectionGroup('rounds').where('active', '==', true).limit(200).get();
    const report = { activeRounds: active.size, ticked: 0, overdue: 0, rescheduled: 0, finalized: 0, errors: 0 };
    for (const doc of active.docs) {
      const r = doc.data() as RoundDoc;
      try {
        const due = nextScheduledEvent(r);
        if (due && due.at <= now) {
          if (now - due.at > 20_000) report.overdue++;
          await this.tick(r.sessionId, r.id);
          report.ticked++;
        } else {
          await this.scheduleNext(r.sessionId, r);
          report.rescheduled++;
        }
      } catch (err) {
        report.errors++;
        this.d.log.error({ err, roundId: r.id }, 'watchdog tick failed');
      }
    }
    const unfinalized = await this.d.db.collectionGroup('rounds').where('summaryReady', '==', false).limit(50).get();
    for (const doc of unfinalized.docs) {
      const r = doc.data() as RoundDoc;
      if (!isFinishedState(r.state)) continue;
      try {
        await finalizeRound(this.d, r.sessionId, r.id);
        report.finalized++;
      } catch (err) {
        report.errors++;
        this.d.log.error({ err, roundId: r.id }, 'watchdog finalize failed');
      }
    }
    this.d.log.info({ watchdog: report }, 'watchdog pass');
    return report;
  }
}
