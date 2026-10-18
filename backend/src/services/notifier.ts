import type { FastifyBaseLogger } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import type { NotificationIntent } from '../domain/types.js';

/**
 * Push notifications are supplementary (spec §14): they never drive the clock
 * and never carry coordinates. Delivery failures are logged and ignored.
 */
export interface Notifier {
  send(intents: NotificationIntent[]): Promise<void>;
}

export class FcmNotifier implements Notifier {
  constructor(
    private db: Firestore,
    private messaging: () => Messaging,
    private log: FastifyBaseLogger,
  ) {}

  async send(intents: NotificationIntent[]) {
    for (const n of intents) {
      for (const uid of n.toUids) {
        try {
          const snap = await this.db.collection('users').doc(uid).collection('devices').get();
          const tokens = snap.docs.map((d) => d.get('fcmToken') as string | undefined).filter((t): t is string => !!t);
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
  async send(intents: NotificationIntent[]) {
    for (const n of intents) this.log.info({ push: n.kind, to: n.toUids, title: n.title, body: n.body }, 'push (log notifier)');
  }
}

export class RecordingNotifier implements Notifier {
  readonly sent: NotificationIntent[] = [];
  async send(intents: NotificationIntent[]) {
    this.sent.push(...intents);
  }
}
