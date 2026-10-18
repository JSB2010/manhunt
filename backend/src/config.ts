/**
 * Runtime configuration from environment variables. No secrets are read here
 * directly — Cloud Run injects Secret Manager values as env vars, and Firebase
 * Admin uses the attached service account (Application Default Credentials).
 */
export interface Config {
  env: 'local' | 'test' | 'dev' | 'prod';
  projectId: string;
  port: number;
  bucket: string;
  scheduler: 'cloudtasks' | 'local' | 'manual';
  tasksLocation: string;
  tasksQueue: string;
  workerUrl: string;
  tasksInvokerServiceAccount: string;
  workerAudience: string;
  /** dev-only shared secret for the local worker; ignored when env=prod */
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
  const scheduler = str('SCHEDULER', env === 'prod' || env === 'dev' ? 'cloudtasks' : 'local') as Config['scheduler'];
  const cfg: Config = {
    env,
    projectId,
    port: Number(str('PORT', '8787')),
    bucket: str('MEDIA_BUCKET', `${projectId}.appspot.com`),
    scheduler,
    tasksLocation: str('TASKS_LOCATION', 'us-central1'),
    tasksQueue: str('TASKS_QUEUE', 'round-deadlines'),
    workerUrl: str('WORKER_URL', 'http://127.0.0.1:8788'),
    tasksInvokerServiceAccount: str('TASKS_INVOKER_SA', ''),
    workerAudience: str('WORKER_AUDIENCE', str('WORKER_URL', 'http://127.0.0.1:8788')),
    devWorkerSecret: env === 'prod' ? null : str('DEV_WORKER_SECRET', 'local-dev-worker-secret'),
    notifier: str('NOTIFIER', env === 'prod' || env === 'dev' ? 'fcm' : 'log') as Config['notifier'],
    inviteTtlMinutes: Number(str('INVITE_TTL_MINUTES', '60')),
    maxPhotoBytes: Number(str('MAX_PHOTO_BYTES', String(8 * 1024 * 1024))),
    usingEmulators,
    watchdogIntervalMs: Number(str('LOCAL_WATCHDOG_MS', '15000')),
    ...overrides,
  };
  if ((cfg.env === 'prod' || cfg.env === 'dev') && cfg.scheduler === 'cloudtasks' && !cfg.tasksInvokerServiceAccount) {
    throw new Error('TASKS_INVOKER_SA is required for Cloud Tasks scheduling');
  }
  return cfg;
}
