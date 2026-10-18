import { buildDeps } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { buildWorkerApp } from './worker/app.js';

const cfg = loadConfig();
const log = createLogger(cfg, 'manhunt-worker');
const deps = buildDeps(cfg, log);
const invokers = (process.env.WORKER_ALLOWED_INVOKERS ?? cfg.tasksInvokerServiceAccount).split(',').map((s) => s.trim()).filter(Boolean);
const app = await buildWorkerApp(deps, { allowedInvokers: invokers, audience: cfg.workerAudience, devSecret: cfg.devWorkerSecret });
await app.listen({ host: '0.0.0.0', port: cfg.port });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
