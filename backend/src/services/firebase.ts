import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import type { Config } from '../config.js';

export interface FirebaseHandles {
  app: App;
  db: Firestore;
  auth: Auth;
  messaging: () => Messaging;
  bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>;
}

let cached: FirebaseHandles | null = null;

/**
 * Initializes Firebase Admin with Application Default Credentials (the function's
 * attached service account in production; emulators locally). Never loads a
 * JSON key file.
 */
export function firebase(cfg: Config): FirebaseHandles {
  if (cached) return cached;
  const app = getApps()[0] ?? initializeApp({ projectId: cfg.projectId, storageBucket: cfg.bucket });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  cached = {
    app,
    db,
    auth: getAuth(app),
    messaging: () => getMessaging(app),
    bucket: getStorage(app).bucket(cfg.bucket),
  };
  return cached;
}
