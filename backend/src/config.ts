/**
 * Runtime configuration from environment variables. No secrets are read here;
 * Firebase Admin uses the function's service account (Application Default
 * Credentials). In Cloud Functions, APP_ENV comes from the deploy-time param.
 */
export interface Config {
  env: 'local' | 'test' | 'dev' | 'prod';
  projectId: string;
  port: number;
  bucket: string;
  scheduler: 'taskqueue' | 'local' | 'manual';
  /** region of the task-queue function that receives deadline wake-ups */
  tasksLocation: string;
  tasksFunction: string;
  /** local worker for the in-process scheduler (dev only) */
  workerUrl: string;
  /** shared secret for the local worker; null when deployed (no worker HTTP app runs there) */
  devWorkerSecret: string | null;
  notifier: 'fcm' | 'log';
  inviteTtlMinutes: number;
  maxPhotoBytes: number;
  usingEmulators: boolean;
  watchdogIntervalMs: number;
}

const str = (k: string, d?: string): string => {
  const v = process.env[k];
  if (v === undefined || v === '') {
    if (d === undefined) throw new Error(`Missing required env var ${k}`);
    return d;
  }
  return v;
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = str('APP_ENV', 'local') as Config['env'];
  const projectId = str('GOOGLE_CLOUD_PROJECT', process.env.GCLOUD_PROJECT ?? 'demo-manhunt');
  const usingEmulators = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (env === 'prod' && usingEmulators) throw new Error('Refusing to run APP_ENV=prod against emulators');
  if (env !== 'prod' && env !== 'dev' && !projectId.startsWith('demo-') && !usingEmulators) {
    throw new Error('Local/test runs must use a demo- project id or the Firebase emulators');
  }
  const deployed = env === 'prod' || env === 'dev';
  const scheduler = str('SCHEDULER', deployed ? 'taskqueue' : 'local') as Config['scheduler'];
  const cfg: Config = {
    env,
    projectId,
    port: Number(str('PORT', '8787')),
    bucket: str('MEDIA_BUCKET', deployed ? `${projectId}-manhunt-media` : `${projectId}.appspot.com`),
    scheduler,
    tasksLocation: str('TASKS_LOCATION', 'us-central1'),
    tasksFunction: str('TASKS_FUNCTION', 'tick'),
    workerUrl: str('WORKER_URL', 'http://127.0.0.1:8788'),
    devWorkerSecret: deployed ? null : str('DEV_WORKER_SECRET', 'local-dev-worker-secret'),
    notifier: str('NOTIFIER', deployed ? 'fcm' : 'log') as Config['notifier'],
    inviteTtlMinutes: Number(str('INVITE_TTL_MINUTES', '60')),
    maxPhotoBytes: Number(str('MAX_PHOTO_BYTES', String(8 * 1024 * 1024))),
    usingEmulators,
    watchdogIntervalMs: Number(str('LOCAL_WATCHDOG_MS', '15000')),
    ...overrides,
  };
  return cfg;
}
