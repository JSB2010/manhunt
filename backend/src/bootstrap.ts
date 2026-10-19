import type { FastifyBaseLogger } from 'fastify';
import { getFunctions } from 'firebase-admin/functions';
import type { Config } from './config.js';
import { firebase } from './services/firebase.js';
import { FcmNotifier, LogNotifier } from './services/notifier.js';
import { systemClock, type Deps } from './services/repo.js';
import { LocalScheduler, ManualScheduler, TaskQueueScheduler } from './services/scheduler.js';
import { GcsObjectStore } from './services/storage.js';

export function buildDeps(cfg: Config, log: FastifyBaseLogger): Deps {
  const fb = firebase(cfg);
  const scheduler =
    cfg.scheduler === 'taskqueue'
      ? new TaskQueueScheduler(getFunctions(fb.app).taskQueue(TaskQueueScheduler.functionPath(cfg)), log)
      : cfg.scheduler === 'local'
        ? new LocalScheduler(cfg, log)
        : new ManualScheduler();
  const notifier = cfg.notifier === 'fcm' ? new FcmNotifier(fb.db, fb.messaging, log) : new LogNotifier(log);
  return {
    cfg,
    db: fb.db,
    store: new GcsObjectStore(fb.bucket),
    scheduler,
    notifier,
    clock: systemClock,
    log,
    deleteAuthUser: async (uid) => {
      await fb.auth.deleteUser(uid).catch((err: { code?: string }) => {
        if (err.code !== 'auth/user-not-found') throw err;
      });
    },
  };
}
