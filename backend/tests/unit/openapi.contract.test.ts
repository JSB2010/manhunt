import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildApiApp } from '../../src/api/app.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/observability/logger.js';
import { RecordingLiveActivityTransport } from '../../src/services/liveActivities.js';
import { RecordingNotifier } from '../../src/services/notifier.js';
import type { Deps } from '../../src/services/repo.js';
import { ManualScheduler } from '../../src/services/scheduler.js';
import { MemoryObjectStore } from '../../src/services/storage.js';

/** Contract test: shared/openapi.yaml documents exactly the routes the API registers. */
describe('OpenAPI contract', () => {
  it('every registered route is documented and every documented route exists', async () => {
    process.env.APP_ENV = 'test';
    const cfg = loadConfig({ env: 'test', scheduler: 'manual', notifier: 'log', projectId: 'demo-manhunt' });
    const deps: Deps = { cfg, db: {} as never, store: new MemoryObjectStore(), scheduler: new ManualScheduler(), notifier: new RecordingNotifier(), liveActivityTransport: new RecordingLiveActivityTransport(), clock: { now: () => 0 }, log: createLogger(cfg, 'contract') };
    const app = await buildApiApp(deps, { verifyIdToken: async () => { throw new Error('unused'); } });
    await app.ready();
    const registered = new Set(app.registeredRoutes.map((r) => `${r.method} ${r.url.replace(/:([A-Za-z]+)/g, '{$1}')}`));
    const spec = parseYaml(readFileSync(new URL('../../../shared/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${path}`)),
    );
    expect([...registered].filter((r) => !documented.has(r)).sort()).toEqual([]);
    expect([...documented].filter((r) => !registered.has(r)).sort()).toEqual([]);
    // Private worker routes must never be on the public API.
    expect([...registered].some((r) => r.includes('/internal/'))).toBe(false);
    await app.close();
  });
});
