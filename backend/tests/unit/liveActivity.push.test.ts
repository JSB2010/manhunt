import { describe, expect, it } from 'vitest';
import type { NotificationIntent } from '../../src/domain/types.js';
import type { LiveActivityState } from '../../src/domain/views.js';
import { apsPayload, FcmLiveActivityTransport, LIVE_ACTIVITY_ALERT_KINDS, type LiveActivityPush } from '../../src/services/liveActivities.js';
import { FcmNotifier } from '../../src/services/notifier.js';

const state: LiveActivityState = {
  phase: 'CHASE',
  pausedPhase: null,
  safetyPause: false,
  headStartEndsAt: null,
  headStartRemaining: null,
  chaseStartedAt: 1_792_267_800,
  chaseElapsed: null,
  nextPingAt: 1_792_268_400,
  nextPingIndex: 1,
  timeCapAt: null,
  lastPing: { index: 0, at: 1_792_267_800, missing: false },
  pingWaiting: false,
  claim: null,
  outcome: null,
};
const base: LiveActivityPush = { fcmToken: 'fcm', activityToken: 'abcd', event: 'update', timestamp: 1_792_267_801, contentState: state, priority: 5 };

describe('ActivityKit payload (developer.apple.com: Starting and updating Live Activities with ActivityKit push notifications)', () => {
  it('update: timestamp, event and content-state with the Swift ContentState keys; stale-date in whole seconds', () => {
    expect(apsPayload({ ...base, staleDate: 1_792_268_490.5 })).toEqual({ timestamp: 1_792_267_801, event: 'update', 'content-state': state, 'stale-date': 1_792_268_490 });
  });

  it('an alert lights the screen with the notification text and sound', () => {
    expect(apsPayload({ ...base, alert: { title: 'New ping', body: 'New hiding-crew location available.' }, priority: 10 })).toMatchObject({
      alert: { title: 'New ping', body: 'New hiding-crew location available.' },
      sound: 'default',
    });
  });

  it('end carries the final state and the dismissal date (0 = remove now)', () => {
    expect(apsPayload({ ...base, event: 'end', dismissalDate: 1_792_268_700.2 })).toMatchObject({ event: 'end', 'dismissal-date': 1_792_268_700 });
    expect(apsPayload({ ...base, event: 'end', dismissalDate: 0 })['dismissal-date']).toBe(0);
  });

  it('start names the attributes type and asks for an update token (iOS 18 input-push-token)', () => {
    const attributes = { sessionId: 's', roundId: 'r', roundIndex: 1, role: 'SEEKING' as const, crew: 'B' as const, crewName: 'Hounds' };
    expect(apsPayload({ ...base, event: 'start', attributes, alert: { title: 'Round 1 started', body: 'x' } })).toMatchObject({
      event: 'start',
      'attributes-type': 'RoundActivityAttributes',
      attributes,
      'input-push-token': 1,
      alert: { title: 'Round 1 started' },
    });
  });

  it('FCM message: device token + apns.liveActivityToken + priority header', async () => {
    const sent: unknown[] = [];
    const t = new FcmLiveActivityTransport(() => ({ send: async (m: unknown) => (sent.push(m), 'id') }) as never);
    expect(await t.send({ ...base, priority: 10 })).toEqual({ ok: true });
    expect(sent[0]).toEqual({ token: 'fcm', apns: { liveActivityToken: 'abcd', headers: { 'apns-priority': '10' }, payload: { aps: apsPayload(base) } } });
    const failing = new FcmLiveActivityTransport(() => ({ send: async () => Promise.reject(Object.assign(new Error('x'), { code: 'messaging/invalid-argument' })) }) as never);
    expect(await failing.send(base)).toEqual({ ok: false, invalidToken: true, credentialsRejected: false, error: 'messaging/invalid-argument' });
    // A rejected APNs key is the project's problem, not the token's: the token stays.
    const keyRejected = new FcmLiveActivityTransport(() => ({ send: async () => Promise.reject(Object.assign(new Error('x'), { code: 'messaging/third-party-auth-error' })) }) as never);
    expect(await keyRejected.send(base)).toEqual({ ok: false, invalidToken: false, credentialsRejected: true, error: 'messaging/third-party-auth-error' });
  });

  it('actionable requests stay regular pushes', () => {
    for (const k of ['PAUSE_REQUESTED', 'RESUME_VOTE', 'NEXT_ROUND', 'ALL_READY', 'OPERATOR_JOINED']) expect(LIVE_ACTIVITY_ALERT_KINDS.has(k)).toBe(false);
  });
});

describe('FcmNotifier with Live Activity alerts', () => {
  it('skips exactly the devices whose activity carried that notification', async () => {
    const devices = [
      { id: 'phone-with-activity', fcmToken: 'fcm-1' },
      { id: 'ipad', fcmToken: 'fcm-2' },
    ];
    const db = {
      collection: () => ({ doc: () => ({ collection: () => ({ get: async () => ({ docs: devices.map((d) => ({ id: d.id, get: () => d.fcmToken, ref: { delete: async () => undefined } })) }) }) }) }),
    };
    const multicasts: string[][] = [];
    const messaging = { sendEachForMulticast: async (m: { tokens: string[] }) => (multicasts.push(m.tokens), { responses: m.tokens.map(() => ({ success: true })) }) };
    const n = new FcmNotifier(db as never, () => messaging as never, { warn: () => undefined } as never);
    const ping: NotificationIntent = { toUids: ['u1'], kind: 'PING_RELEASED', title: 'New ping', body: 'x', sessionId: 's', roundId: 'r1' };
    await n.send([ping], [{ uid: 'u1', deviceId: 'phone-with-activity', roundId: 'r1', kind: 'PING_RELEASED' }]);
    expect(multicasts).toEqual([['fcm-2']]);
    // Another kind, another round, or another phone is not covered.
    await n.send([{ ...ping, kind: 'PING_LATE' }, { ...ping, roundId: 'r2' }], [{ uid: 'u1', deviceId: 'phone-with-activity', roundId: 'r1', kind: 'PING_RELEASED' }]);
    expect(multicasts.slice(1)).toEqual([
      ['fcm-1', 'fcm-2'],
      ['fcm-1', 'fcm-2'],
    ]);
  });
});

describe('FcmNotifier delivery failures', () => {
  it('prunes dead tokens and logs every other failure by code, never the token', async () => {
    const devices = [
      { id: 'a', fcmToken: 'fcm-dead' },
      { id: 'b', fcmToken: 'fcm-apns' },
      { id: 'c', fcmToken: 'fcm-ok' },
    ];
    const deleted: string[] = [];
    const db = {
      collection: () => ({
        doc: () => ({ collection: () => ({ get: async () => ({ docs: devices.map((d) => ({ id: d.id, get: () => d.fcmToken, ref: { delete: async () => void deleted.push(d.id) } })) }) }) }),
      }),
    };
    const codes: Record<string, string> = { 'fcm-dead': 'messaging/registration-token-not-registered', 'fcm-apns': 'messaging/third-party-auth-error' };
    const messaging = {
      sendEachForMulticast: async (m: { tokens: string[] }) => ({ responses: m.tokens.map((t) => (codes[t] ? { success: false, error: { code: codes[t] } } : { success: true })) }),
    };
    const logged: unknown[] = [];
    const n = new FcmNotifier(db as never, () => messaging as never, { warn: (o: unknown) => void logged.push(o) } as never);
    await n.send([{ toUids: ['u1'], kind: 'CLAIM_SUBMITTED', title: 't', body: 'b', sessionId: 's', roundId: 'r' }]);
    expect(deleted).toEqual(['a']);
    expect(logged).toEqual([{ kind: 'CLAIM_SUBMITTED', failures: { 'messaging/third-party-auth-error': 1 } }]);
    expect(JSON.stringify(logged)).not.toContain('fcm-');
  });
});
