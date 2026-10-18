import { buildApiApp } from './api/app.js';
import { buildDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { firebase } from './services/firebase.js';

const cfg = loadConfig();
const log = createLogger(cfg, 'manhunt-api');
const deps = buildDeps(cfg, log);
const fb = firebase(cfg);
const app = await buildApiApp(deps, { verifyIdToken: (t) => fb.auth.verifyIdToken(t) });
await app.listen({ host: '0.0.0.0', port: cfg.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
