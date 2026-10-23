import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { Timestamp } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import type { z } from 'zod';
import { roundUids } from '../domain/crews.js';
import { fail } from '../domain/errors.js';
import { isActiveState, type CaptureClaim, type MemberDoc, type NotificationIntent, type RoundDoc, type SessionDoc } from '../domain/types.js';
import { liveActivityAttributes, liveActivityStaleDate, liveActivityState, renderRound, renderView, type LiveActivityAttributes, type LiveActivityState } from '../domain/views.js';
import type { LiveActivityStartTokenBody, LiveActivityTokenBody } from '../schemas/api.js';
import { paths, type Deps } from './repo.js';

/**
 * Live Activities (ADR 0017): the round on the Lock Screen, in the Dynamic Island, the
 * Apple Watch Smart Stack and CarPlay. The app starts and updates its own activity
 * while it runs; this service keeps it current while the app is suspended, using
 * ActivityKit pushes sent through FCM. Like every push it is supplementary: it never
 * drives the clock, and its content comes only from the phone's sanitized view.
 */

/** iOS `RoundActivityAttributes` (the `attributes-type` of a push-to-start). */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'RoundActivityAttributes';
/** An ended round stays on the Lock Screen this long (HIG: 15–30 minutes). */
export const LIVE_ACTIVITY_DISMISS_AFTER_MS = 15 * 60_000;
/** Registrations outlive any round (ActivityKit ends an activity after 8 h, 12 h on the Lock Screen). */
const REGISTRATION_TTL_MS = 12 * 3600_000;

/**
 * Round notifications a Live Activity update carries as its alert. A phone whose
 * activity got the alert doesn't also get the regular push (HIG: don't send both for
 * the same update). Requests that need an answer in the app stay regular pushes.
 */
export const LIVE_ACTIVITY_ALERT_KINDS: ReadonlySet<string> = new Set([
  'ROUND_STARTED',
  'CHASE_STARTED',
  'PING_RELEASED',
  'PING_LATE',
  'PING_WAITING',
  'CLAIM_SUBMITTED',
  'CLAIM_CONFIRMED',
  'CLAIM_REJECTED',
  'CLAIM_EXPIRED',
  'SAFETY_PAUSE',
  'PAUSED',
  'RESUMED',
  'ROUND_TIMED_OUT',
  'ROUND_ABORTED',
]);

/** Server-only: `sessions/{sid}/liveActivities/{uid}_{deviceId}`. */
export interface LiveActivityRegistration {
  uid: string;
  deviceId: string;
  roundId: string;
  /** ActivityKit push token of the activity (hex) */
  pushToken: string;
  /** the phone's clock minus server time, so the system's timers read server time */
  clockOffsetMs: number;
  /** round.version of the last content sent; only newer versions go out */
  sentVersion: number;
  stateHash: string | null;
  createdAt: number;
  updatedAt: number;
  expireAt: Timestamp;
}

/** A phone whose Live Activity carried a notification as its alert. */
export interface LiveActivityAlertDelivery {
  uid: string;
  deviceId: string;
  roundId: string;
  kind: string;
}

export interface LiveActivityPush {
  /** FCM registration token of the device (FCM needs it next to the ActivityKit token) */
  fcmToken: string;
  /** push-to-start token for `start`, the activity's push token otherwise */
  activityToken: string;
  event: 'start' | 'update' | 'end';
  /** epoch seconds; ActivityKit shows the newest */
  timestamp: number;
  contentState: LiveActivityState;
  attributes?: LiveActivityAttributes;
  alert?: { title: string; body: string };
  staleDate?: number | null;
  dismissalDate?: number;
  /** 10 = immediate and counted against the budget; 5 = opportunistic */
  priority: 5 | 10;
}

/**
 * `credentialsRejected`: APNs refused the project's credentials (not this token) — every other
 * push would fail the same way until the APNs key in Firebase is fixed.
 */
export type LiveActivitySendResult = { ok: true } | { ok: false; invalidToken: boolean; credentialsRejected?: boolean; error: string };

/** FCM codes that mean APNs rejected the project's credentials rather than one token. */
const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  'messaging/third-party-auth-error',
  'messaging/mismatched-credential',
  'messaging/invalid-apns-credentials',
  'messaging/authentication-error',
]);
/** After a credentials rejection, Live Activity pushes pause this long (per instance); alerts fall back to regular pushes. */
export const LIVE_ACTIVITY_BACKOFF_MS = 10 * 60_000;
/** Pushes in flight at once per publish. */
const PUSH_CONCURRENCY = 8;

/** Run `fn` over `items` with at most `limit` in flight. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

export interface LiveActivityTransport {
  send(push: LiveActivityPush): Promise<LiveActivitySendResult>;
}

/** ActivityKit payload (`aps`) for a push. Exported for tests. */
export function apsPayload(p: LiveActivityPush): Record<string, unknown> {
  return {
    timestamp: p.timestamp,
    event: p.event,
    'content-state': p.contentState,
    ...(p.staleDate ? { 'stale-date': Math.floor(p.staleDate) } : {}),
    ...(p.dismissalDate !== undefined ? { 'dismissal-date': Math.floor(p.dismissalDate) } : {}),
    ...(p.alert ? { alert: { title: p.alert.title, body: p.alert.body }, sound: 'default' } : {}),
    ...(p.event === 'start' ? { 'attributes-type': LIVE_ACTIVITY_ATTRIBUTES_TYPE, attributes: p.attributes, 'input-push-token': 1 } : {}),
  };
}

/** Sends through FCM HTTP v1 (`apns.live_activity_token`); the APNs key is the project's existing FCM key. */
export class FcmLiveActivityTransport implements LiveActivityTransport {
  constructor(private messaging: () => Messaging) {}

  async send(p: LiveActivityPush): Promise<LiveActivitySendResult> {
    try {
      await this.messaging().send({
        token: p.fcmToken,
        apns: {
          liveActivityToken: p.activityToken,
          headers: { 'apns-priority': String(p.priority) },
          payload: { aps: apsPayload(p) as never },
        },
      });
      return { ok: true };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      // FCM reports a dead device token, or an ActivityKit token APNs rejects, as one of these.
      const invalidToken = code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument';
      return { ok: false, invalidToken, credentialsRejected: CREDENTIAL_ERRORS.has(code), error: code };
    }
  }
}

/** Local development: log the event (never tokens or content). */
export class LogLiveActivityTransport implements LiveActivityTransport {
  constructor(private log: FastifyBaseLogger) {}
  async send(p: LiveActivityPush): Promise<LiveActivitySendResult> {
    this.log.info({ liveActivity: p.event, phase: p.contentState.phase, alert: p.alert?.title ?? null, priority: p.priority }, 'live activity push (log transport)');
    return { ok: true };
  }
}

export class RecordingLiveActivityTransport implements LiveActivityTransport {
  readonly sent: LiveActivityPush[] = [];
  /** activity tokens that fail as invalid */
  readonly invalid = new Set<string>();
  /** APNs rejects the project's credentials (every push fails) */
  rejectCredentials = false;
  attempts = 0;
  async send(p: LiveActivityPush): Promise<LiveActivitySendResult> {
    this.attempts++;
    if (this.rejectCredentials) return { ok: false, invalidToken: false, credentialsRejected: true, error: 'messaging/third-party-auth-error' };
    if (this.invalid.has(p.activityToken)) return { ok: false, invalidToken: true, error: 'messaging/invalid-argument' };
    this.sent.push(structuredClone(p));
    return { ok: true };
  }
}

const hashState = (s: LiveActivityState) => createHash('sha256').update(JSON.stringify(s)).digest('base64url').slice(0, 22);
const seconds = (ms: number) => ms / 1000;

export class LiveActivityService {
  private p;
  /** Live Activity pushes are paused until then: APNs rejected the project's credentials. */
  private static credentialsRejectedUntil = 0;
  constructor(private d: Deps) {
    this.p = paths(d.db);
  }

  /** For tests: forget a credentials rejection. */
  static resetBackoff() {
    LiveActivityService.credentialsRejectedUntil = 0;
  }

  private pushesPaused(now: number) {
    return now < LiveActivityService.credentialsRejectedUntil;
  }

  /** Send one push; a credentials rejection pauses the rest (logged once, with the fix). */
  private async send(push: LiveActivityPush, roundId: string, now: number): Promise<LiveActivitySendResult> {
    if (this.pushesPaused(now)) return { ok: false, invalidToken: false, credentialsRejected: true, error: 'paused' };
    const res = await this.d.liveActivityTransport.send(push);
    if (!res.ok && res.credentialsRejected) {
      if (!this.pushesPaused(now)) {
        this.d.log.error(
          { error: res.error, roundId },
          'live activity pushes rejected by APNs: check the APNs auth key (.p8) in Firebase > Cloud Messaging; pausing them and sending regular pushes',
        );
      }
      LiveActivityService.credentialsRejectedUntil = now + LIVE_ACTIVITY_BACKOFF_MS;
    } else if (!res.ok) {
      this.d.log.warn({ error: res.error, roundId, event: push.event }, 'live activity push failed');
    }
    return res;
  }

  private registrations(sid: string) {
    return this.d.db.collection('sessions').doc(sid).collection('liveActivities');
  }

  /** The app reports its activity's push token (and clock offset) for a round it plays. */
  async register(uid: string, sid: string, rid: string, deviceId: string, body: z.infer<typeof LiveActivityTokenBody>) {
    const [session, round] = await Promise.all([this.p.session(sid).get(), this.p.round(sid, rid).get()]);
    const s = session.data() as SessionDoc | undefined;
    const r = round.data() as RoundDoc | undefined;
    if (!s || !r || !s.memberUids.includes(uid) || s.revokedAt) fail('NOT_FOUND', 'Round not found');
    if (!isActiveState(r!.state)) fail('STALE_PHASE', 'The round is not in progress');
    if (!roundUids(r!).includes(uid)) fail('OPERATOR_NOT_AUTHORIZED', 'This phone is not playing this round');
    const now = this.d.clock.now();
    const ref = this.registrations(sid).doc(`${uid}_${deviceId}`);
    const prev = (await ref.get()).data() as LiveActivityRegistration | undefined;
    const same = prev?.roundId === rid && prev.pushToken === body.pushToken;
    const reg: LiveActivityRegistration = {
      uid,
      deviceId,
      roundId: rid,
      pushToken: body.pushToken,
      clockOffsetMs: body.clockOffsetMs,
      // A new activity (or token) starts from whatever the app last rendered; the next transition updates it.
      sentVersion: same ? prev.sentVersion : r!.version,
      stateHash: same ? prev.stateHash : null,
      createdAt: same ? prev.createdAt : now,
      updatedAt: now,
      expireAt: Timestamp.fromMillis(now + REGISTRATION_TTL_MS),
    };
    await ref.set(reg);
    return { ok: true };
  }

  async unregister(uid: string, sid: string, rid: string, deviceId: string) {
    const ref = this.registrations(sid).doc(`${uid}_${deviceId}`);
    const reg = (await ref.get()).data() as LiveActivityRegistration | undefined;
    if (reg && reg.roundId === rid) await ref.delete();
    return { ok: true };
  }

  /** Push-to-start token (null: Live Activities turned off in the app). Stored on the device record. */
  async registerStartToken(uid: string, body: z.infer<typeof LiveActivityStartTokenBody>) {
    await this.p.devices(uid).doc(body.deviceId).set({ liveActivityStartToken: body.pushToStartToken, updatedAt: this.d.clock.now() }, { merge: true });
    return { ok: true };
  }

  /**
   * After a committed round change: start activities on phones that have none yet (the
   * round just started), update the others, end them when the round ends. Returns the
   * phones whose activity carried a notification as its alert, so the notifier skips
   * the duplicate push. Failures are logged, never thrown.
   */
  async publish(p: {
    session: SessionDoc;
    round: RoundDoc;
    members: Record<string, MemberDoc>;
    claim: CaptureClaim | null;
    notifications: NotificationIntent[];
    /** this change started the round (READY → HEAD_START) */
    started: boolean;
    /** the phone that started it; it starts its own activity in the foreground */
    actorUid?: string | null;
    now: number;
  }): Promise<LiveActivityAlertDelivery[]> {
    const { session, round, members, now } = p;
    const deliveries: LiveActivityAlertDelivery[] = [];
    const activeClaim = p.claim && round.activeClaimId === p.claim.claimId ? p.claim : null;
    const alertFor = (uid: string) => p.notifications.find((n) => n.roundId === round.id && LIVE_ACTIVITY_ALERT_KINDS.has(n.kind) && n.toUids.includes(uid));
    try {
      // Paused after APNs rejected the credentials: the app still updates its own activity, and
      // every alert goes out as a regular push. Registrations keep their version for later.
      if (this.pushesPaused(now)) return deliveries;
      const regs = await this.registrations(session.id).where('roundId', '==', round.id).get();
      const registered = new Set(regs.docs.map((doc) => (doc.data() as LiveActivityRegistration).uid));
      // Pushes go out in parallel: one slow or failing push no longer holds up the request (and the next one).
      await eachLimited(regs.docs, PUSH_CONCURRENCY, async (doc) => {
        const reg = doc.data() as LiveActivityRegistration;
        if (round.version <= reg.sentVersion) return;
        const view = renderRound({ uid: reg.uid, session, round, members, activeClaim, now });
        const state = liveActivityState(view, reg.clockOffsetMs);
        if (!state) {
          // Off the round (phone removed): the app ends its activity when it sees its view.
          await doc.ref.delete();
          return;
        }
        const hash = hashState(state);
        if (hash === reg.stateHash) return;
        const fcmToken = await this.fcmToken(reg.uid, reg.deviceId);
        if (!fcmToken || this.pushesPaused(now)) return;
        // Claim this version; a concurrent publish for the same doc loses the precondition and skips.
        const claimed = await doc.ref.update({ sentVersion: round.version, stateHash: hash, updatedAt: now }, { lastUpdateTime: doc.updateTime }).then(
          () => true,
          () => false,
        );
        if (!claimed) return;
        const ended = state.phase === 'ENDED';
        const alert = alertFor(reg.uid);
        const res = await this.send(
          {
            fcmToken,
            activityToken: reg.pushToken,
            event: ended ? 'end' : 'update',
            timestamp: Math.floor(seconds(now)),
            contentState: state,
            staleDate: liveActivityStaleDate(state),
            ...(ended ? { dismissalDate: seconds(now + LIVE_ACTIVITY_DISMISS_AFTER_MS + reg.clockOffsetMs) } : {}),
            ...(alert ? { alert: { title: alert.title, body: alert.body } } : {}),
            priority: alert ? 10 : 5,
          },
          round.id,
          now,
        );
        if (res.ok && alert) deliveries.push({ uid: reg.uid, deviceId: reg.deviceId, roundId: round.id, kind: alert.kind });
        // Not sent (credentials): let a later version try again once pushes work.
        if (!res.ok && res.credentialsRejected) await doc.ref.update({ sentVersion: reg.sentVersion, stateHash: reg.stateHash }).catch(() => undefined);
        if ((res.ok && ended) || (!res.ok && res.invalidToken)) await doc.ref.delete();
      });

      // Round just started: push-to-start on the other phones of the round (iOS 17.2+).
      if (p.started) {
        const starts: { uid: string; dev: FirebaseFirestore.QueryDocumentSnapshot; push: LiveActivityPush; alertKind: string | null }[] = [];
        for (const uid of roundUids(round)) {
          if (uid === p.actorUid || registered.has(uid)) continue;
          const view = renderView({ uid, session, round, members, activeClaim, now });
          const attributes = liveActivityAttributes(view);
          const state = view.round && liveActivityState(view.round);
          if (!attributes || !state) continue;
          const alert = alertFor(uid);
          const devices = await this.p.devices(uid).get();
          for (const dev of devices.docs) {
            const startToken = dev.get('liveActivityStartToken') as string | null | undefined;
            const fcmToken = dev.get('fcmToken') as string | undefined;
            if (!startToken || !fcmToken) continue;
            starts.push({
              uid,
              dev,
              alertKind: alert?.kind ?? null,
              push: {
                fcmToken,
                activityToken: startToken,
                event: 'start',
                timestamp: Math.floor(seconds(now)),
                attributes,
                // The phone's offset isn't known until its activity registers; the first update corrects it.
                contentState: state,
                staleDate: liveActivityStaleDate(state),
                ...(alert ? { alert: { title: alert.title, body: alert.body } } : {}),
                priority: 10,
              },
            });
          }
        }
        await eachLimited(starts, PUSH_CONCURRENCY, async ({ uid, dev, push, alertKind }) => {
          const res = await this.send(push, round.id, now);
          if (res.ok && alertKind) deliveries.push({ uid, deviceId: dev.id, roundId: round.id, kind: alertKind });
          if (!res.ok && res.invalidToken) await dev.ref.update({ liveActivityStartToken: null });
        });
      }
    } catch (err) {
      this.d.log.warn({ err, roundId: round.id }, 'live activity publish failed');
    }
    return deliveries;
  }

  /** Session revoked: end every activity at once and forget the tokens. */
  async endAll(sid: string, round: RoundDoc | null) {
    const regs = await this.registrations(sid).get();
    const now = this.d.clock.now();
    for (const doc of regs.docs) {
      const reg = doc.data() as LiveActivityRegistration;
      const fcmToken = round?.id === reg.roundId ? await this.fcmToken(reg.uid, reg.deviceId) : undefined;
      if (fcmToken && round && isActiveState(round.state)) {
        const state: LiveActivityState = {
          phase: 'ENDED',
          pausedPhase: null,
          safetyPause: false,
          headStartEndsAt: null,
          headStartRemaining: null,
          chaseStartedAt: null,
          chaseElapsed: null,
          nextPingAt: null,
          nextPingIndex: round.nextPingIndex,
          timeCapAt: null,
          lastPing: null,
          pingWaiting: false,
          claim: null,
          outcome: { result: 'ABORTED', creditCrews: [] },
        };
        await this.d.liveActivityTransport
          .send({ fcmToken, activityToken: reg.pushToken, event: 'end', timestamp: Math.floor(seconds(now)), contentState: state, dismissalDate: 0, priority: 10 })
          .catch(() => undefined);
      }
      await doc.ref.delete();
    }
  }

  /** A phone's registrations in one night (account deletion, "delete my data"). */
  async forget(uid: string, sid: string) {
    const regs = await this.registrations(sid).where('uid', '==', uid).get();
    await Promise.all(regs.docs.map((d) => d.ref.delete()));
  }

  private async fcmToken(uid: string, deviceId: string): Promise<string | undefined> {
    return (await this.p.devices(uid).doc(deviceId).get()).get('fcmToken') as string | undefined;
  }
}

