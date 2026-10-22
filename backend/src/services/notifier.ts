import type { FastifyBaseLogger } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import type { NotificationIntent } from '../domain/types.js';
import type { LiveActivityAlertDelivery } from './liveActivities.js';

/**
 * Push notifications are supplementary (spec §14): they never drive the clock
 * and never carry coordinates. Delivery failures are logged and ignored.
 */
export interface Notifier {
  /** `liveActivityAlerts`: devices whose Live Activity already carried that notification as its alert get no separate push. */
  send(intents: NotificationIntent[], liveActivityAlerts?: LiveActivityAlertDelivery[]): Promise<void>;
}

/** The notification already reached this device as a Live Activity alert. */
export const alertedByLiveActivity = (alerts: LiveActivityAlertDelivery[], n: NotificationIntent, uid: string, deviceId: string) =>
  alerts.some((a) => a.uid === uid && a.deviceId === deviceId && a.kind === n.kind && a.roundId === n.roundId);

export class FcmNotifier implements Notifier {
  constructor(
    private db: Firestore,
    private messaging: () => Messaging,
    private log: FastifyBaseLogger,
  ) {}

  async send(intents: NotificationIntent[], liveActivityAlerts: LiveActivityAlertDelivery[] = []) {
    for (const n of intents) {
      for (const uid of n.toUids) {
        try {
          const snap = await this.db.collection('users').doc(uid).collection('devices').get();
          const tokens = snap.docs
            .filter((d) => !alertedByLiveActivity(liveActivityAlerts, n, uid, d.id))
            .map((d) => d.get('fcmToken') as string | undefined)
            .filter((t): t is string => !!t);
          if (!tokens.length) continue;
          const res = await this.messaging().sendEachForMulticast({
            tokens,
            notification: { title: n.title, body: n.body },
            data: { kind: n.kind, sessionId: n.sessionId, roundId: n.roundId ?? '' },
            apns: { payload: { aps: { sound: 'default', 'interruption-level': n.kind === 'SAFETY_PAUSE' ? 'time-sensitive' : 'active' } } },
          });
          // Prune tokens FCM reports as permanently invalid.
          await Promise.all(
            res.responses.map(async (r, i) => {
              const code = r.error?.code;
              if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                const bad = snap.docs.find((d) => d.get('fcmToken') === tokens[i]);
                if (bad) await bad.ref.delete();
              }
            }),
          );
        } catch (err) {
          this.log.warn({ err, kind: n.kind, uid }, 'push send failed');
        }
      }
    }
  }
}

/** Local development: log intents (kind + recipients only). */
export class LogNotifier implements Notifier {
  constructor(private log: FastifyBaseLogger) {}
  async send(intents: NotificationIntent[], liveActivityAlerts: LiveActivityAlertDelivery[] = []) {
    for (const n of intents) this.log.info({ push: n.kind, to: n.toUids, title: n.title, body: n.body, viaLiveActivity: liveActivityAlerts.filter((a) => a.kind === n.kind).length }, 'push (log notifier)');
  }
}

export class RecordingNotifier implements Notifier {
  readonly sent: NotificationIntent[] = [];
  /** devices skipped because their Live Activity carried the alert */
  readonly liveActivityAlerts: LiveActivityAlertDelivery[] = [];
  async send(intents: NotificationIntent[], liveActivityAlerts: LiveActivityAlertDelivery[] = []) {
    this.sent.push(...intents);
    this.liveActivityAlerts.push(...liveActivityAlerts);
  }
}
