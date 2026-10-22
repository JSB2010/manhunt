import { createHash, randomInt } from 'node:crypto';
import { Timestamp, type Transaction } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { effectiveChaseMs } from '../domain/clock.js';
import { crewOfUid, hiderUids, operatorUidsOf, roleOf, roundTeams, roundUids, rosterFingerprint, seekerUids, snapshotTeamOf, teamKeysOf } from '../domain/crews.js';
import {
  abortRound,
  createRound,
  decideClaim,
  nextScheduledEvent,
  proposeDisputeResolution,
  refreshReadyRound,
  removePhoneFromRound,
  requestPause,
  roundBrief,
  setReady as engineSetReady,
  startRound as engineStartRound,
  submitClaim,
  suggestedHidingTeam,
  voteResume,
  type Transition,
} from '../domain/engine.js';
import { AppError, fail } from '../domain/errors.js';
import { isValidCoordinate } from '../domain/geo.js';
import { DEFAULT_RULES, mergeRules } from '../domain/rules.js';
import { tickRound, tryLateRelease, type TickDeps } from '../domain/tick.js';
import {
  isActiveState,
  isFinishedState,
  MAX_OPERATORS_PER_TEAM,
  MIN_TEAMS,
  TEAM_KEYS,
  type CaptureClaim,
  type DeviceHealth,
  type DomainEvent,
  type GpsPoint,
  type MemberDoc,
  type NotificationIntent,
  type PersonRef,
  type RoundDoc,
  type SessionDoc,
  type Team,
  type TeamKey,
} from '../domain/types.js';
import { renderView, trackingState, type ViewDoc } from '../domain/views.js';
import type {
  AbortBody,
  ConsentBody,
  CreateSessionBody,
  HealthInput,
  LocationBatchBody,
  NextRoundBody,
  PauseBody,
  RosterEntry,
  SetupPatchBody,
} from '../schemas/api.js';
import { finalizeRound } from './finalize.js';
import { LiveActivityService } from './liveActivities.js';
import { paths, txGet, txMembers, writeEvents, writeViews, type Deps } from './repo.js';
import { stripJpegMetadata } from './storage.js';
import { resolvePeopleForRoster } from './socialService.js';

const TEAM_COLORS: Record<TeamKey, string> = { A: '#1E88E5', B: '#F4511E', C: '#43A047' };
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CONSENT_VERSION = 'v1';
/** Late uploads are accepted (for history only) this long after a round ends. */
const LATE_UPLOAD_WINDOW_MS = 30 * 60_000;
const RAW_POINT_RETENTION_MS = 30 * 24 * 3600_000;
const UPLOAD_TICKET_MS = 10 * 60_000;
/** Claims per seeking crew per round. */
const MAX_CLAIMS_PER_CREW = 20;
/** A night code stays valid until the night ends (bounded for cleanup). */
const NIGHT_CODE_TTL_MS = 7 * 24 * 3600_000;
const NIGHT_CODE_MAX_USES = 1000;
/** Hider candidates read per ping decision (newest first). */
const CANDIDATE_LIMIT = 300;

export const hashCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const newCode = () => Array.from({ length: 8 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');

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

/** What other phones see of a phone (views.crewStatus) changed: re-render; otherwise a plain health write. */
function coarseHealthChanged(a: DeviceHealth, b: DeviceHealth, now: number): boolean {
  return (
    trackingState(a, now) !== trackingState(b, now) ||
    a.preciseLocation !== b.preciseLocation ||
    a.lowPowerMode !== b.lowPowerMode ||
    a.permission !== b.permission ||
    a.trackingActive !== b.trackingActive
  );
}

const hasConsent = (m: MemberDoc | undefined) => !!m?.active && !!m.consent && !m.consentRevokedAt;

/** The crew with the fewest phones (ties: key order) — where new and displaced phones go. */
function emptiestCrew(session: SessionDoc, exclude: TeamKey | null = null): TeamKey {
  const keys = teamKeysOf(session).filter((k) => k !== exclude);
  return keys.sort((a, b) => session.teams[a]!.operatorUids.length - session.teams[b]!.operatorUids.length || a.localeCompare(b))[0]!;
}

function assertDisjointRosters(session: SessionDoc) {
  const seen = new Map<string, TeamKey>();
  for (const k of teamKeysOf(session)) {
    for (const p of session.teams[k]!.roster) {
      if (seen.has(p.personId) && seen.get(p.personId) !== k) fail('VALIDATION_FAILED', `${p.displayName} can't be on two crews`);
      seen.set(p.personId, k);
    }
  }
}

interface TxCtx<Rd extends RoundDoc | null> {
  tx: Transaction;
  session: SessionDoc;
  round: Rd;
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
  /** the phone that caused the change (it updates its own Live Activity in the foreground) */
  actorUid?: string;
  /** throw this after commit (e.g. expiry applied, then report CAPTURE_EXPIRED) */
  errorAfterCommit?: AppError;
}

export class GameService {
  private p;
  private liveActivities: LiveActivityService;
  constructor(private d: Deps) {
    this.p = paths(d.db);
    this.liveActivities = new LiveActivityService(d);
  }

  // -------------------------------------------------------------------------
  // Shared transaction plumbing
  // -------------------------------------------------------------------------

  /** Any active operator phone of the night acts for its crew. */
  private requireOperator(session: SessionDoc, members: Record<string, MemberDoc>, uid: string): TeamKey {
    const team = crewOfUid(session, uid);
    if (!team || !members[uid]?.active) fail('OPERATOR_NOT_AUTHORIZED', 'You are not on a crew in this night');
    return team!;
  }

  private requireOpenNight(session: SessionDoc) {
    if (session.status === 'COMPLETED') fail('GAME_CLOSED', 'The night has ended');
  }

  /** Hiding-crew samples of a round, read inside the transaction (role is stamped from the snapshot at ingest). */
  private hiderSamples(tx: Transaction, sid: string, rid: string): TickDeps['hiderSamples'] {
    return async (from, to) => {
      const q = this.p
        .points(sid, rid)
        .where('role', '==', 'HIDING')
        .where('recordedAt', '>=', from)
        .where('recordedAt', '<=', to)
        .orderBy('recordedAt', 'desc')
        .limit(CANDIDATE_LIMIT);
      const snap = await tx.get(q);
      return snap.docs.map((d) => d.data() as GpsPoint);
    };
  }

  /** Night never auto-completes: a finished round only adds its brief. */
  private onRoundFinished(session: SessionDoc, round: RoundDoc, now: number): SessionDoc {
    if (session.roundBriefs.some((b) => b.roundId === round.id)) return session;
    const brief = roundBrief(round, rosterFingerprint(round.rosterSnapshot[round.hidingTeam]));
    if (!brief) return session;
    const s = structuredClone(session);
    s.roundBriefs.push(brief);
    s.completedRoundCount = s.roundBriefs.length;
    if (s.status !== 'COMPLETED') s.status = 'BETWEEN_ROUNDS';
    s.updatedAt = now;
    s.version++;
    return s;
  }

  /**
   * Run a state change inside a Firestore transaction, then re-render every
   * member's view in the same commit. `round` is null only for a night with no
   * round document (ended before round 1 was created).
   */
  private async nightTx<R>(sid: string, rid: string | null, fn: (c: TxCtx<RoundDoc | null>) => Promise<TxOutcome<R>>): Promise<R> {
    const db = this.d.db;
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session) fail('NOT_FOUND', 'Session not found');
      if (session!.revokedAt) fail('GAME_CLOSED', 'This session was revoked');
      const roundId = rid ?? session!.currentRoundId;
      if (rid && session!.currentRoundId !== rid && !session!.roundIds.includes(rid)) fail('NOT_FOUND', 'Round not found');
      const round = roundId ? await txGet<RoundDoc>(tx, this.p.round(sid, roundId)) : null;
      if (rid && !round) fail('NOT_FOUND', 'Round not found');
      const members = await txMembers(tx, db, sid);
      const claim = round?.activeClaimId ? await txGet<CaptureClaim>(tx, this.p.claim(sid, round.id, round.activeClaimId)) : null;
      // A transaction on an earlier round (e.g. a stale worker wake-up for its
      // claim window) must still render views from the session's current round.
      const currentId = session!.currentRoundId;
      const current = round && currentId && currentId !== round.id ? await txGet<RoundDoc>(tx, this.p.round(sid, currentId)) : null;
      const currentClaim = current?.activeClaimId ? await txGet<CaptureClaim>(tx, this.p.claim(sid, current.id, current.activeClaimId)) : null;
      const o = await fn({ tx, session: session!, round, members, claim, now });

      let nextSession = o.session ?? session!;
      const nextRound = o.round ?? round;
      if (o.round && isFinishedState(o.round.state) && round && !isFinishedState(round.state)) {
        nextSession = this.onRoundFinished(nextSession, o.round, now);
      }
      const nextMembers = { ...(o.members ?? members) };
      const nextClaim = o.claim !== undefined ? o.claim : claim;

      if (nextSession !== session) tx.set(this.p.session(sid), nextSession);
      if (o.round) {
        tx.set(this.p.round(sid, o.round.id), o.round);
        // Immutable per-index ping records: tx.create fails if one already exists,
        // so a duplicate release can never commit (spec §15.3 quality gate).
        const before = round?.id === o.round.id ? round.pings : [];
        for (const ping of o.round.pings) {
          if (!before.some((x) => x.index === ping.index)) tx.create(this.p.pingDoc(sid, o.round.id, ping.index), { ...ping, roundId: o.round.id });
        }
      }
      if (o.claim && nextRound) tx.set(this.p.claim(sid, nextRound.id, o.claim.claimId), o.claim);
      writeEvents(tx, db, sid, o.events ?? []);
      const edited = o.members ? Object.keys(o.members).filter((u) => o.members![u] !== members[u]) : [];
      if (current && nextSession.currentRoundId === current.id) {
        writeViews(tx, db, nextSession, current, nextMembers, currentClaim, now, { except: edited });
      } else {
        const viewClaim = nextClaim && nextRound?.activeClaimId === nextClaim.claimId ? nextClaim : null;
        writeViews(tx, db, nextSession, nextRound, nextMembers, viewClaim, now, { except: edited });
      }
      // Edited member docs are written once, carrying their new view hashes.
      for (const u of edited) tx.set(this.p.member(sid, u), nextMembers[u]!);
      return {
        o,
        nextRound,
        roundChanged: !!o.round,
        wasFinished: !!round && isFinishedState(round.state),
        live: { session: nextSession, members: nextMembers, claim: nextClaim, started: round?.state === 'READY' && o.round?.state === 'HEAD_START', actorUid: o.actorUid ?? null },
      };
    });
    if (out.nextRound) await this.afterCommit(sid, out.nextRound, out.o.notifications ?? [], out.roundChanged && !out.wasFinished, out.live);
    else if (out.o.notifications?.length) this.d.notifier.send(out.o.notifications).catch((err) => this.d.log.warn({ err }, 'notify failed'));
    if (out.o.errorAfterCommit) throw out.o.errorAfterCommit;
    return out.o.result;
  }

  /** nightTx for actions that need a round. */
  private roundTx<R>(sid: string, rid: string | null, fn: (c: TxCtx<RoundDoc>) => Promise<TxOutcome<R>>): Promise<R> {
    return this.nightTx(sid, rid, async (c) => {
      if (!c.round) fail('NOT_FOUND', 'No round in this session');
      return fn(c as TxCtx<RoundDoc>);
    });
  }

  private async afterCommit(
    sid: string,
    round: RoundDoc,
    notifications: NotificationIntent[],
    roundChanged: boolean,
    live: { session: SessionDoc; members: Record<string, MemberDoc>; claim: CaptureClaim | null; started: boolean; actorUid: string | null },
  ) {
    // Live Activities first: a phone whose activity carried an alert skips the duplicate push.
    const alerts = roundChanged ? await this.liveActivities.publish({ ...live, round, notifications, now: this.d.clock.now() }) : [];
    if (notifications.length) {
      this.d.notifier.send(notifications, alerts).catch((err) => this.d.log.warn({ err }, 'notify failed'));
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
    const sid = this.p.sessions().doc().id;
    const rid = this.p.rounds(sid).doc().id;
    const teams: SessionDoc['teams'] = {};
    for (const k of TEAM_KEYS) {
      const t = input.teams[k];
      if (!t) continue;
      teams[k] = {
        teamId: this.p.sessions().doc().id,
        key: k,
        name: t.name,
        color: t.color ?? TEAM_COLORS[k],
        operatorUids: input.myTeam === k ? [uid] : [],
        roster: await resolvePeopleForRoster(this.d, uid, t.roster),
      };
    }
    const code = newCode();
    const session: SessionDoc = {
      id: sid,
      title: input.title,
      scheduledDate: input.scheduledDate,
      hostUid: uid,
      status: 'LOBBY',
      rules,
      teams,
      memberUids: [uid],
      participantPersonIds: [...new Set(Object.values(teams).flatMap((t) => t!.roster.map((p) => p.personId)))],
      groupId: input.groupId ?? null,
      currentRoundId: rid,
      roundIds: [rid],
      completedRoundCount: 0,
      keepPhotos: {},
      joinCode: code,
      roundBriefs: [],
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    assertDisjointRosters(session);
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
      selfPersonId: (user!.selfPersonId as string | undefined) ?? null,
    };
    const t = createRound({ id: rid, session, index: 1, hidingTeam: input.firstHidingTeam ?? suggestedHidingTeam(session), seekMode: input.seekMode ?? 'TOGETHER', actorUid: uid, now });
    const members = { [uid]: member };
    const inviteRef = this.p.invites().doc();
    await db.runTransaction(async (tx) => {
      tx.create(this.p.session(sid), session);
      tx.create(this.p.round(sid, rid), t.round);
      tx.create(inviteRef, this.nightCodeDoc(inviteRef.id, session, code, uid, user!.displayName as string, now));
      writeEvents(tx, db, sid, [{ type: 'SESSION_CREATED', at: now, actorUid: uid, roundId: null, details: { crews: teamKeysOf(session).length } }, ...t.events]);
      writeViews(tx, db, session, t.round, members, null, now, { except: [uid] });
      tx.create(this.p.member(sid, uid), members[uid]!);
    });
    return renderView({ uid, session, round: t.round, members, activeClaim: null, now });
  }

  private nightCodeDoc(id: string, session: SessionDoc, code: string, uid: string, displayName: string, now: number) {
    const expiresAt = now + NIGHT_CODE_TTL_MS;
    return {
      id,
      kind: 'NIGHT',
      codeHash: hashCode(code),
      sessionId: session.id,
      sessionTitle: session.title,
      teamKey: null,
      teamName: null,
      hostDisplayName: displayName,
      targetUid: null,
      createdByUid: uid,
      createdAt: now,
      expiresAt,
      expireAt: Timestamp.fromMillis(expiresAt + 24 * 3600_000),
      maxUses: NIGHT_CODE_MAX_USES,
      uses: 0,
      revoked: false,
    };
  }

  /**
   * The phone's stored view — the same document its Firestore listener gets,
   * in one read. Views exist only for active members of non-revoked nights.
   */
  async getView(uid: string, sid: string): Promise<ViewDoc> {
    const stored = (await this.p.view(sid, uid).get()).data() as ViewDoc | undefined;
    if (stored?.uid === uid) return stored;
    return this.renderFreshView(uid, sid);
  }

  /** Fallback when a view has not been written yet: render from the authoritative documents. */
  private async renderFreshView(uid: string, sid: string): Promise<ViewDoc> {
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
        [s.title, s.scheduledDate, ...teamKeysOf(s).flatMap((k) => [s.teams[k]!.name, ...s.teams[k]!.roster.map((p) => p.displayName)])]
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
        myTeam: crewOfUid(s, uid),
        completedRoundCount: s.completedRoundCount,
        teams: Object.fromEntries(
          teamKeysOf(s).map((k) => {
            const t = s.teams[k]!;
            return [k, { name: t.name, color: t.color, roster: t.roster, phoneCount: t.operatorUids.length }];
          }),
        ),
        groupId: s.groupId,
        createdAt: new Date(s.createdAt).toISOString(),
      })),
      nextBefore: items.length === opts.limit ? items[items.length - 1]!.createdAt : null,
    };
  }

  // -------------------------------------------------------------------------
  // Night code (one reusable code per night) and direct friend invites
  // -------------------------------------------------------------------------

  /**
   * Returns the night's code (any operator), regenerating it on request. With
   * `targetUid`, also sends a direct invite to a friend (shows in their app).
   */
  async createInvite(uid: string, sid: string, input: { targetUid?: string | undefined; regenerate?: boolean | undefined }) {
    const db = this.d.db;
    const user = (await this.p.user(uid).get()).data();
    if (input.targetUid) {
      const fr = await this.p.friendship([uid, input.targetUid].sort().join('_')).get();
      if (!fr.exists || fr.get('blocked')) fail('FORBIDDEN', 'You can only directly invite accounts on your friends list');
    }
    const existing = await this.p.invites().where('sessionId', '==', sid).where('revoked', '==', false).get();
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session || !session.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
      const members = await txMembers(tx, db, sid);
      this.requireOperator(session!, members, uid);
      this.requireOpenNight(session!);
      if (session!.revokedAt) fail('GAME_CLOSED', 'Session is closed');
      const round = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(sid, session!.currentRoundId)) : null;
      const night = existing.docs.map((d) => d.data()).find((d) => d.kind === 'NIGHT' && d.expiresAt > now);
      let code = session!.joinCode;
      let expiresAt: number = night?.expiresAt ?? 0;
      if (input.regenerate || !code || !night) {
        for (const d of existing.docs) if (d.get('kind') === 'NIGHT') tx.update(d.ref, { revoked: true });
        code = newCode();
        const ref = this.p.invites().doc();
        const doc = this.nightCodeDoc(ref.id, session!, code, uid, user?.displayName as string, now);
        expiresAt = doc.expiresAt;
        tx.create(ref, doc);
        const s = { ...structuredClone(session!), joinCode: code, updatedAt: now, version: session!.version + 1 };
        tx.set(this.p.session(sid), s);
        writeViews(tx, db, s, round, members, null, now);
      }
      let inviteId: string | null = null;
      if (input.targetUid) {
        if (session!.memberUids.includes(input.targetUid) && members[input.targetUid]?.active) fail('CONFLICT', 'They are already in this night');
        const ref = this.p.invites().doc();
        inviteId = ref.id;
        const directExpires = now + this.d.cfg.inviteTtlMinutes * 60_000 * 12;
        tx.create(ref, {
          id: ref.id,
          kind: 'DIRECT',
          codeHash: null,
          sessionId: sid,
          sessionTitle: session!.title,
          teamKey: null,
          teamName: null,
          hostDisplayName: user?.displayName ?? null,
          targetUid: input.targetUid,
          createdByUid: uid,
          createdAt: now,
          expiresAt: directExpires,
          expireAt: Timestamp.fromMillis(directExpires + 24 * 3600_000),
          maxUses: 1,
          uses: 0,
          revoked: false,
        });
      }
      return { code: code!, expiresAt, inviteId, title: session!.title };
    });
    if (input.targetUid) {
      this.d.notifier
        .send([{ toUids: [input.targetUid], kind: 'SESSION_INVITE', title: 'Manhunt invite', body: `${user?.displayName ?? 'A friend'} invited you to ${out.title}.`, sessionId: sid, roundId: null }])
        .catch(() => undefined);
    }
    return {
      code: out.code,
      inviteId: out.inviteId,
      expiresAt: new Date(out.expiresAt).toISOString(),
      deepLink: `manhuntcrews://join?code=${out.code}`,
    };
  }

  private async findInvite(uid: string, input: { code?: string | undefined; inviteId?: string | undefined }, tx?: Transaction) {
    const now = this.d.clock.now();
    let ref;
    if (input.code) {
      const q = this.p.invites().where('codeHash', '==', hashCode(input.code)).limit(1);
      ref = (tx ? await tx.get(q) : await q.get()).docs[0]?.ref;
    } else ref = this.p.invite(input.inviteId!);
    const inv = ref ? (tx ? await tx.get(ref) : await ref.get()).data() : undefined;
    if (!inv || inv.revoked || inv.expiresAt < now || inv.uses >= inv.maxUses || (inv.targetUid && inv.targetUid !== uid)) {
      fail('INVITE_INVALID', 'That code is invalid or expired');
    }
    return { ref: ref!, inv: inv! };
  }

  async previewInvite(uid: string, input: { code?: string | undefined; inviteId?: string | undefined }) {
    const { inv } = await this.findInvite(uid, input);
    const session = (await this.p.session(inv.sessionId).get()).data() as SessionDoc | undefined;
    if (!session || session.revokedAt || session.status === 'COMPLETED') fail('INVITE_INVALID', 'That night has ended');
    const myTeam = crewOfUid(session!, uid);
    return {
      sessionId: session!.id,
      title: session!.title,
      scheduledDate: session!.scheduledDate,
      teams: Object.fromEntries(
        teamKeysOf(session!).map((k) => {
          const t = session!.teams[k]!;
          return [k, { name: t.name, color: t.color, roster: t.roster, phoneCount: t.operatorUids.length, full: t.operatorUids.length >= MAX_OPERATORS_PER_TEAM }];
        }),
      ),
      suggestedTeam: emptiestCrew(session!),
      myTeam,
      hostDisplayName: inv.hostDisplayName as string | null,
      rules: session!.rules,
      expiresAt: new Date(inv.expiresAt).toISOString(),
    };
  }

  async redeemInvite(uid: string, input: { code?: string | undefined; inviteId?: string | undefined; teamKey?: TeamKey | undefined }): Promise<ViewDoc> {
    const db = this.d.db;
    const user = (await this.p.user(uid).get()).data();
    if (!user) fail('NOT_FOUND', 'Profile not found');
    const displayName = user!.displayName as string;
    const result = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const { ref: invRef, inv } = await this.findInvite(uid, input, tx);
      const session = await txGet<SessionDoc>(tx, this.p.session(inv.sessionId));
      if (!session || session.revokedAt || session.status === 'COMPLETED') fail('GAME_CLOSED', 'That night has ended');
      const members = await txMembers(tx, db, session!.id);
      const round = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(session!.id, session!.currentRoundId)) : null;
      const current = crewOfUid(session!, uid);
      if (current && members[uid]?.active) {
        // Already on a crew: re-opening the code is a no-op.
        return { view: renderView({ uid, session: session!, round, members, activeClaim: null, now }), notify: null };
      }
      const s = structuredClone(session!);
      const teamKey = input.teamKey ?? emptiestCrew(s);
      const crew = s.teams[teamKey];
      if (!crew) fail('VALIDATION_FAILED', 'That crew is not part of this night');
      if (crew!.operatorUids.length >= MAX_OPERATORS_PER_TEAM) fail('CONFLICT', `${crew!.name} already has ${MAX_OPERATORS_PER_TEAM} phones`);
      crew!.operatorUids.push(uid);
      // The phone's owner plays on its crew; add their own person record unless a crew already
      // lists them — by record, or by name (a guest entry the organizer typed for them).
      const selfPersonId = (user!.selfPersonId as string | undefined) ?? null;
      const sameName = (p: PersonRef) => p.personId === selfPersonId || p.displayName.trim().toLowerCase() === displayName.trim().toLowerCase();
      if (selfPersonId && !teamKeysOf(s).some((k) => s.teams[k]!.roster.some(sameName))) {
        crew!.roster.push({ personId: selfPersonId, displayName });
        s.participantPersonIds = [...new Set([...s.participantPersonIds, selfPersonId])];
      }
      if (!s.memberUids.includes(uid)) s.memberUids.push(uid);
      s.updatedAt = now;
      s.version++;
      const member: MemberDoc = {
        ...(members[uid] ?? { uid, sessionId: s.id, isHost: false, joinedAt: now, consent: null, consentRevokedAt: null, health: emptyHealth() }),
        teamKey,
        active: true,
        displayName,
        selfPersonId,
      };
      const nextMembers = { ...members, [uid]: member };
      let r = round;
      if (r && r.state === 'READY') {
        r = refreshReadyRound(r, s, now);
        tx.set(this.p.round(s.id, r.id), r);
      }
      tx.update(invRef, { uses: inv.uses + 1, lastRedeemedByUid: uid, lastRedeemedAt: now });
      tx.set(this.p.session(s.id), s);
      writeEvents(tx, db, s.id, [{ type: 'OPERATOR_JOINED', at: now, actorUid: uid, roundId: null, details: { team: teamKey } }]);
      writeViews(tx, db, s, r, nextMembers, null, now, { except: [uid] });
      tx.set(this.p.member(s.id, uid), nextMembers[uid]!);
      return {
        view: renderView({ uid, session: s, round: r, members: nextMembers, activeClaim: null, now }),
        notify: { toUids: operatorUidsOf(s).filter((u) => u !== uid), sid: s.id, teamName: crew!.name },
      };
    });
    if (result.notify?.toUids.length) {
      this.d.notifier
        .send([{ toUids: result.notify.toUids, kind: 'OPERATOR_JOINED', title: 'Phone joined', body: `${displayName} joined ${result.notify.teamName}.`, sessionId: result.notify.sid, roundId: null }])
        .catch(() => undefined);
    }
    return result.view;
  }

  // -------------------------------------------------------------------------
  // Consent, readiness, between-rounds editing
  // -------------------------------------------------------------------------

  async setConsent(uid: string, sid: string, input: z.infer<typeof ConsentBody>) {
    return this.nightTx(sid, null, async ({ session, round, members, now }) => {
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
        events.push({ type: 'CONSENT_REVOKED', at: now, actorUid: uid, roundId: round?.id ?? null, details: { team } });
        if (round && isActiveState(round.state)) {
          // The phone leaves the round; the round aborts only if its crew has no phone left.
          const t = removePhoneFromRound(round, uid, 'Tracking consent withdrawn', now);
          if (t.round !== round) r = t.round;
          events.push(...t.events);
          notifications = t.notifications;
        } else if (round?.state === 'READY' && round.ready[team]?.uid === uid) {
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
      if (ready && !hasConsent(m)) fail('CONSENT_REQUIRED', 'Accept the tracking and route disclosure first');
      m.health = healthFrom(preflight, m.health, now);
      // Any phone of the crew sets or clears the crew's mark; a repeat mark only refreshes health.
      if (ready && round.state === 'READY' && round.ready[team]) return { result: { ok: true }, members: { ...members, [uid]: m } };
      const t = engineSetReady(round, team, uid, ready, now);
      return { result: { ok: true }, round: t.round, members: { ...members, [uid]: m }, events: t.events, notifications: t.notifications };
    });
  }

  /**
   * Between-rounds editor (any operator): title, default rules, crews (add,
   * rename, remove, rosters) and which crew each phone is on. A READY round is
   * refreshed from the new setup.
   */
  async editSetup(uid: string, sid: string, patch: z.infer<typeof SetupPatchBody>) {
    // Resolve new roster names to person records before the transaction (it may create people).
    const pre = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!pre || !pre.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    const resolved: Partial<Record<TeamKey, PersonRef[]>> = {};
    for (const k of TEAM_KEYS) {
      const roster = patch.teams?.[k]?.roster;
      if (roster) resolved[k] = await this.resolveRoster(uid, pre!, roster);
    }
    return this.nightTx(sid, null, async ({ session, round, members, now }) => {
      this.requireOperator(session, members, uid);
      this.requireOpenNight(session);
      if (round && round.state !== 'READY' && !isFinishedState(round.state)) fail('GAME_CLOSED', 'Setup cannot change during a round');
      const s = structuredClone(session);
      const events: DomainEvent[] = [];
      const nextMembers = { ...members };
      if (patch.title) s.title = patch.title;
      if (patch.scheduledDate) s.scheduledDate = patch.scheduledDate;
      if (patch.rules) s.rules = mergeRules(s.rules, patch.rules);

      for (const k of TEAM_KEYS) {
        const tp = patch.teams?.[k];
        if (tp === undefined) continue;
        if (tp === null) {
          if (!s.teams[k]) continue;
          const displaced = s.teams[k]!.operatorUids;
          delete s.teams[k];
          delete s.keepPhotos[k];
          if (teamKeysOf(s).length < MIN_TEAMS) fail('VALIDATION_FAILED', 'A night needs at least two crews');
          for (const u of displaced) this.movePhone(s, nextMembers, u, emptiestCrew(s), uid, now, events);
          continue;
        }
        if (!s.teams[k]) {
          if (!tp.name) fail('VALIDATION_FAILED', 'A new crew needs a name');
          s.teams[k] = { teamId: this.p.sessions().doc().id, key: k, name: tp.name!, color: tp.color ?? TEAM_COLORS[k], operatorUids: [], roster: [] } satisfies Team;
        }
        const t = s.teams[k]!;
        if (tp.name) t.name = tp.name;
        if (tp.color) t.color = tp.color;
        if (resolved[k]) t.roster = resolved[k]!;
      }

      for (const mv of patch.moves ?? []) {
        if (!crewOfUid(s, mv.uid)) fail('VALIDATION_FAILED', 'That phone is not on a crew');
        if (mv.teamKey === null) {
          if (mv.uid === s.hostUid) fail('FORBIDDEN', "The organizer's phone can't be removed");
          this.removePhone(s, nextMembers, mv.uid, uid, now, events);
        } else {
          if (!s.teams[mv.teamKey]) fail('VALIDATION_FAILED', 'That crew is not part of this night');
          this.movePhone(s, nextMembers, mv.uid, mv.teamKey, uid, now, events);
        }
      }
      for (const k of teamKeysOf(s)) {
        if (s.teams[k]!.operatorUids.length > MAX_OPERATORS_PER_TEAM) fail('VALIDATION_FAILED', `${s.teams[k]!.name} can have at most ${MAX_OPERATORS_PER_TEAM} phones`);
      }
      assertDisjointRosters(s);
      s.participantPersonIds = [...new Set([...s.participantPersonIds, ...teamKeysOf(s).flatMap((k) => s.teams[k]!.roster.map((p) => p.personId))])];
      s.updatedAt = now;
      s.version++;
      const r = round?.state === 'READY' ? refreshReadyRound(round, s, now) : undefined;
      events.unshift({ type: 'SETUP_EDITED', at: now, actorUid: uid, roundId: round?.id ?? null, details: { fields: Object.keys(patch).join(',') } });
      return { result: { ok: true }, session: s, members: nextMembers, ...(r ? { round: r } : {}), events };
    });
  }

  /** Roster entries already in this night skip the visibility check (another operator added them). */
  private async resolveRoster(uid: string, session: SessionDoc, roster: z.infer<typeof RosterEntry>[]): Promise<PersonRef[]> {
    const known = new Set(session.participantPersonIds);
    const out: PersonRef[] = [];
    for (const e of roster) {
      if (e.personId && known.has(e.personId)) out.push({ personId: e.personId, displayName: e.displayName });
      else out.push(...(await resolvePeopleForRoster(this.d, uid, [e])));
    }
    return out;
  }

  private movePhone(s: SessionDoc, members: Record<string, MemberDoc>, phone: string, to: TeamKey, actor: string, now: number, events: DomainEvent[]) {
    const from = crewOfUid(s, phone);
    if (from === to) return;
    if (from) s.teams[from]!.operatorUids = s.teams[from]!.operatorUids.filter((u) => u !== phone);
    s.teams[to]!.operatorUids.push(phone);
    if (members[phone]) members[phone] = { ...members[phone]!, teamKey: to };
    events.push({ type: 'OPERATOR_MOVED', at: now, actorUid: actor, roundId: null, details: { uid: phone, from, to } });
  }

  private removePhone(s: SessionDoc, members: Record<string, MemberDoc>, phone: string, actor: string, now: number, events: DomainEvent[]) {
    const from = crewOfUid(s, phone);
    if (from) s.teams[from]!.operatorUids = s.teams[from]!.operatorUids.filter((u) => u !== phone);
    if (members[phone]) members[phone] = { ...members[phone]!, active: false };
    events.push({ type: 'OPERATOR_REMOVED', at: now, actorUid: actor, roundId: null, details: { uid: phone, from } });
  }

  /**
   * Preflight checks at start (spec §3.2 READY → HEAD_START), per crew across
   * its eligible phones. Blocking only when no phone of a crew can track.
   */
  private startWarnings(session: SessionDoc, round: RoundDoc, members: Record<string, MemberDoc>, eligible: ReadonlySet<string>, now: number) {
    const blocking: string[] = [];
    const warnings = new Set<string>();
    for (const team of roundTeams(round)) {
      const role = team === round.hidingTeam ? 'HIDER' : 'SEEKER';
      // Phones that have reported in (the ready phone always has); the others report once tracking starts.
      const phones = (session.teams[team]?.operatorUids ?? []).filter((u) => eligible.has(u)).map((u) => members[u]!.health).filter((h) => h.lastHeartbeatAt !== null);
      if (!phones.length) continue; // the engine reports a crew without a ready phone
      const permitted = phones.filter((h) => h.permission === 'WHEN_IN_USE' || h.permission === 'ALWAYS');
      if (!permitted.length) blocking.push(`${role}_LOCATION_PERMISSION_DENIED`);
      else if (phones.some((h) => h.permission === 'DENIED' || h.permission === 'RESTRICTED')) warnings.add(`${role}_SOME_PHONES_NO_LOCATION`);
      if (!phones.some((h) => h.preciseLocation)) warnings.add(`${role}_PRECISE_LOCATION_OFF`);
      if (!phones.some((h) => h.lastHeartbeatAt !== null && now - h.lastHeartbeatAt <= 120_000)) warnings.add(`${role}_OFFLINE`);
      if (!phones.some((h) => h.lastSampleRecordedAt !== null && now - h.lastSampleRecordedAt <= 120_000)) warnings.add(`${role}_GPS_STALE`);
      const best = Math.min(...phones.map((h) => h.lastSampleAccuracyMeters ?? Infinity));
      if (Number.isFinite(best) && best > round.rules.maxPingAccuracyMeters) warnings.add(`${role}_GPS_INACCURATE`);
      if (phones.some((h) => h.lowPowerMode)) warnings.add(`${role}_LOW_POWER_MODE`);
    }
    return { blocking, warnings: [...warnings] };
  }

  async startRound(uid: string, sid: string, rid: string, acknowledgeWarnings: boolean) {
    return this.roundTx(sid, rid, async ({ session, round, members, now }) => {
      this.requireOperator(session, members, uid);
      if (round.id !== session.currentRoundId) fail('STALE_PHASE', 'Not the current round');
      if (round.state === 'READY' && roundTeams(round).some((k) => !round.ready[k])) fail('GAME_NOT_READY', 'Every crew must tap Ready');
      const eligible = new Set(operatorUidsOf(session).filter((u) => hasConsent(members[u])));
      const { blocking, warnings } = this.startWarnings(session, round, members, eligible, now);
      if (blocking.length) fail('PERMISSION_REQUIRED', 'Round cannot start until these issues are fixed', { blocking, warnings });
      if (warnings.length && !acknowledgeWarnings) fail('GPS_UNAVAILABLE', 'Location health warnings must be acknowledged to start', { warnings });
      const t: Transition = engineStartRound(round, session, uid, eligible, warnings, now);
      const s = { ...structuredClone(session), status: 'IN_ROUND' as const, updatedAt: now, version: session.version + 1 };
      return { result: { ok: true, warnings }, session: s, round: t.round, events: t.events, notifications: t.notifications, actorUid: uid };
    });
  }

  // -------------------------------------------------------------------------
  // Worker tick (task-queue function / watchdog)
  // -------------------------------------------------------------------------

  async tick(sid: string, rid: string) {
    return this.roundTx(sid, rid, async ({ tx, round, claim, now }) => {
      if (!isActiveState(round.state)) return { result: { processed: [] as unknown[] } };
      const r = await tickRound(round, now, { activeClaim: claim, hiderSamples: this.hiderSamples(tx, sid, rid) });
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
    if (round!.state === 'READY' || round!.roundStartAt === null) fail('GAME_NOT_READY', 'Round has not started; tracking samples are not accepted yet');
    // Crew and role come from the round snapshot — never from the request or the current crew list.
    const team = snapshotTeamOf(round!, uid);
    const role = roleOf(round!, uid);
    if (!team || !role) fail('OPERATOR_NOT_AUTHORIZED', 'This phone is not playing this round');
    const finished = isFinishedState(round!.state);
    if (finished && round!.endedAt !== null && now - round!.endedAt > LATE_UPLOAD_WINDOW_MS) fail('GAME_CLOSED', 'Round closed for uploads');

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
        role: role!,
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

    const inserted = candidates.length - duplicates;
    const newest = candidates.filter((c) => !c.qualityFlags.includes('FUTURE_TIMESTAMP')).sort((a, b) => b.recordedAt - a.recordedAt)[0];
    // A hider fix that gets through releases a waiting ping (ADR 0015). Never fails the upload.
    const releaseCheck = role === 'HIDING' && inserted > 0 && !!round!.waitingPing && !finished;
    await this.afterIngest(uid, sid, rid, body.health, now, newest ? { recordedAt: newest.recordedAt, accuracy: newest.horizontalAccuracyMeters } : undefined, releaseCheck).catch((err) =>
      this.d.log.warn({ err, roundId: rid }, 'post-ingest update failed'),
    );
    if (finished && inserted > 0) {
      await finalizeRound(this.d, sid, rid, { force: true }).catch((err) => this.d.log.warn({ err }, 're-finalize after late upload failed'));
    }
    return { accepted: inserted, duplicates, rejected, clockSkewMs: skew, serverTime: new Date(now).toISOString() };
  }

  /**
   * Health heartbeat, plus the waiting-ping release check (re-validated inside
   * the transaction). Health alone is written to the member doc without a
   * transaction or view render, unless what other phones see of this phone
   * (its coarse tracking state or issues) changes.
   */
  private async afterIngest(
    uid: string,
    sid: string,
    rid: string,
    input: z.infer<typeof HealthInput>,
    now: number,
    lastSample: { recordedAt: number; accuracy: number } | undefined,
    releaseCheck: boolean,
  ) {
    if (!releaseCheck) {
      const m = (await this.p.member(sid, uid).get()).data() as MemberDoc | undefined;
      if (!m) return;
      const health = healthFrom(input, m.health, now, lastSample);
      if (!coarseHealthChanged(m.health, health, now)) {
        await this.p.member(sid, uid).update({ health });
        return;
      }
    }
    await this.nightTx(sid, null, async ({ tx, round, members, now: txNow }) => {
      const m = members[uid];
      if (!m) return { result: null };
      const next = { ...structuredClone(m), health: healthFrom(input, m.health, now, lastSample) };
      const out: TxOutcome<null> = { result: null, members: { ...members, [uid]: next } };
      if (releaseCheck && round?.id === rid && round.waitingPing) {
        const t = await tryLateRelease(round, txNow, this.hiderSamples(tx, sid, rid));
        if (t) Object.assign(out, { round: t.round, events: t.events, notifications: t.notifications });
      }
      return out;
    });
  }

  async myTrack(uid: string, sid: string, rid: string) {
    const round = (await this.p.round(sid, rid).get()).data() as RoundDoc | undefined;
    if (!round || !roundUids(round).includes(uid)) fail('NOT_FOUND', 'Round not found');
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
    if (!seekerUids(round!).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'Only a seeking crew can claim a catch');
    if (round!.state === 'CAPTURE_PENDING') fail('ALREADY_CLAIMED', 'A claim is already awaiting confirmation');
    if (round!.state !== 'CHASE') fail('STALE_PHASE', 'Catches can be claimed only during the chase');
    const team = snapshotTeamOf(round!, uid)!;
    const existing = await this.p.claims(sid, rid).where('seekerTeam', '==', team).count().get();
    if (existing.data().count >= MAX_CLAIMS_PER_CREW) fail('RATE_LIMITED', 'Too many claims this round');
    const ref = this.p.claims(sid, rid).doc();
    const claim: CaptureClaim = {
      claimId: ref.id,
      sessionId: sid,
      roundId: rid,
      seekerUid: uid,
      seekerTeam: team,
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

  /** Any hiding-crew phone decides; concurrent decisions serialize and the loser gets "already decided". */
  async captureDecision(uid: string, sid: string, rid: string, cid: string, decision: 'CONFIRM' | 'REJECT', reason: string | null) {
    return this.roundTx(sid, rid, async ({ tx, round, claim, now }) => {
      const c = claim?.claimId === cid ? claim : await txGet<CaptureClaim>(tx, this.p.claim(sid, rid, cid));
      if (!c) fail('NOT_FOUND', 'Claim not found');
      // Apply any due expiry first so a late decision can never override it.
      if (round.state === 'CAPTURE_PENDING' && round.claimExpiresAt !== null && now > round.claimExpiresAt && round.activeClaimId === cid) {
        const r = await tickRound(round, now, { activeClaim: c, hiderSamples: this.hiderSamples(tx, sid, rid) });
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

  /**
   * Catch photos: the hiding crew (reviewers) and the claiming crew. In TOGETHER
   * mode the other seeking crew shares the catch and may see it; in RACE it may not.
   */
  async getCapturePhoto(uid: string, sid: string, rid: string, cid: string): Promise<Buffer> {
    const [round, claim] = await Promise.all([
      this.p.round(sid, rid).get().then((s) => s.data() as RoundDoc | undefined),
      this.p.claim(sid, rid, cid).get().then((s) => s.data() as CaptureClaim | undefined),
    ]);
    if (!round || !claim || claim.photoDeletedAt) fail('NOT_FOUND', 'Photo not found');
    const team = snapshotTeamOf(round!, uid);
    const allowed = team === round!.hidingTeam || team === claim!.seekerTeam || (round!.seekMode === 'TOGETHER' && !!team && round!.seekingTeams.includes(team));
    if (!allowed) fail('NOT_FOUND', 'Photo not found');
    if (claim!.status === 'UPLOADING' && claim!.seekerUid !== uid) fail('NOT_FOUND', 'Photo not found');
    const bytes = await this.d.store.get(claim!.imageObjectKey);
    if (!bytes) fail('NOT_FOUND', 'Photo not found');
    return bytes!;
  }

  // -------------------------------------------------------------------------
  // Pause / resume / abort / disputes (authority from the round snapshot)
  // -------------------------------------------------------------------------

  async pause(uid: string, sid: string, rid: string, body: z.infer<typeof PauseBody>) {
    return this.roundTx(sid, rid, async ({ round, now }) => {
      const t = requestPause(round, uid, body.kind, body.reason ?? null, now);
      return { result: { state: t.round.state, pendingRequest: !!t.round.pendingPauseRequest }, round: t.round, events: t.events, notifications: t.notifications };
    });
  }

  async resume(uid: string, sid: string, rid: string) {
    return this.roundTx(sid, rid, async ({ round, now }) => {
      const t = voteResume(round, uid, now);
      return { result: { state: t.round.state }, round: t.round, events: t.events, notifications: t.notifications };
    });
  }

  async abort(uid: string, sid: string, rid: string, body: z.infer<typeof AbortBody>) {
    return this.roundTx(sid, rid, async ({ round, claim, now }) => {
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
      if (!members[uid]?.active) fail('OPERATOR_NOT_AUTHORIZED', 'You are not in this night');
      const r = proposeDisputeResolution(round!, claim!, uid, resolution, now);
      tx.set(this.p.claim(sid, rid, cid), r.claim);
      writeEvents(tx, this.d.db, sid, r.events);
      if (r.resolved && r.round.result) {
        tx.set(this.p.round(sid, rid), r.round);
        const s = structuredClone(session!);
        const i = s.roundBriefs.findIndex((b) => b.roundId === rid);
        const brief = roundBrief(r.round, rosterFingerprint(r.round.rosterSnapshot[r.round.hidingTeam]));
        if (i >= 0 && brief) {
          s.roundBriefs[i] = brief;
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
  // Open-ended night: next round, end night
  // -------------------------------------------------------------------------

  /**
   * Set up the next round (any operator). Any crew may hide next; the default
   * is the crew that has hidden least. Calling it while a READY round exists
   * re-targets that round instead of creating another.
   */
  async nextRound(uid: string, sid: string, body: z.infer<typeof NextRoundBody>) {
    const db = this.d.db;
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session || session.revokedAt) fail('NOT_FOUND', 'Session not found');
      const members = await txMembers(tx, db, sid);
      this.requireOperator(session!, members, uid);
      this.requireOpenNight(session!);
      const current = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(sid, session!.currentRoundId)) : null;
      if (current && !isFinishedState(current.state)) {
        if (current.state !== 'READY') fail('STALE_PHASE', 'Finish the current round first');
        const r = refreshReadyRound(current, session!, now, { hidingTeam: body.hidingTeam, seekMode: body.seekMode });
        tx.set(this.p.round(sid, r.id), r);
        writeEvents(tx, db, sid, [{ type: 'SETUP_EDITED', at: now, actorUid: uid, roundId: r.id, details: { hidingTeam: r.hidingTeam, seekMode: r.seekMode } }]);
        writeViews(tx, db, session!, r, members, null, now);
        return { round: r, session: session!, members, notifications: [] as NotificationIntent[] };
      }
      const index = session!.roundIds.length + 1;
      const rid = this.p.rounds(sid).doc().id;
      const t = createRound({
        id: rid,
        session: session!,
        index,
        hidingTeam: body.hidingTeam ?? suggestedHidingTeam(session!),
        seekMode: body.seekMode ?? current?.seekMode ?? 'TOGETHER',
        actorUid: uid,
        now,
      });
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
      return { round: t.round, session: s, members, notifications: t.notifications };
    });
    if (out.notifications.length) this.d.notifier.send(out.notifications.map((n) => ({ ...n, toUids: n.toUids.filter((u) => u !== uid) }))).catch(() => undefined);
    return renderView({ uid, session: out.session, round: out.round, members: out.members, activeClaim: null, now: this.d.clock.now() });
  }

  /** End the night (any operator). A READY round that never started is discarded. */
  async completeSession(uid: string, sid: string) {
    const db = this.d.db;
    const invites = await this.p.invites().where('sessionId', '==', sid).where('revoked', '==', false).get();
    const out = await db.runTransaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await txGet<SessionDoc>(tx, this.p.session(sid));
      if (!session || session.revokedAt) fail('NOT_FOUND', 'Session not found');
      const members = await txMembers(tx, db, sid);
      this.requireOperator(session!, members, uid);
      if (session!.status === 'COMPLETED') return { s: session!, already: true };
      const current = session!.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(sid, session!.currentRoundId)) : null;
      if (current && isActiveState(current.state)) fail('STALE_PHASE', 'Finish or abort the current round first');
      const s = structuredClone(session!);
      let shown = current;
      if (current?.state === 'READY') {
        // Reads first (Firestore transaction rule), then discard the unstarted round.
        s.roundIds = s.roundIds.filter((r) => r !== current.id);
        s.currentRoundId = s.roundIds[s.roundIds.length - 1] ?? null;
        shown = s.currentRoundId ? await txGet<RoundDoc>(tx, this.p.round(sid, s.currentRoundId)) : null;
        tx.delete(this.p.round(sid, current.id));
      }
      s.status = 'COMPLETED';
      s.joinCode = null;
      s.updatedAt = now;
      s.version++;
      for (const d of invites.docs) tx.update(d.ref, { revoked: true });
      tx.set(this.p.session(sid), s);
      writeEvents(tx, db, sid, [{ type: 'SESSION_COMPLETED', at: now, actorUid: uid, roundId: null, details: { rounds: s.roundBriefs.length } }]);
      writeViews(tx, db, s, shown, members, null, now);
      return { s, already: false };
    });
    if (!out.already) {
      this.d.notifier
        .send([{ toUids: operatorUidsOf(out.s).filter((u) => u !== uid), kind: 'SESSION_COMPLETED', title: 'Night over', body: `${out.s.title}: scorecard is ready.`, sessionId: sid, roundId: null }])
        .catch(() => undefined);
    }
    return { ok: true };
  }

  async setKeepPhotos(uid: string, sid: string, keep: boolean) {
    return this.nightTx(sid, null, async ({ session, members, now }) => {
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
        if (due && now - due.at > 20_000) report.overdue++;
        // Every pass ticks each active round: it repairs missed wake-ups, re-checks a
        // waiting ping (backstop for the ingest trigger) and re-renders views whose
        // coarse crew status went stale — all idempotent, and unchanged views are not written.
        await this.tick(r.sessionId, r.id);
        report.ticked++;
        if (!due || due.at > now) {
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
