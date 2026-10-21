import { getApps } from 'firebase-admin/app';
import { describe, expect, it, vi } from 'vitest';

/**
 * Deployed surface (`firebase deploy` reads each export's `__endpoint`): only
 * the API is public; the deadline worker and scheduled jobs are private and
 * run as the least-privilege backend account. Loading the module must not
 * initialize Firebase or need runtime config (deploy-time discovery).
 */
/** Imports the entry point fresh with the given environment, as `firebase deploy` discovery would. */
async function loadFunctions(env: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  vi.resetModules();
  try {
    return (await import('../../src/functions/index.js')) as Record<string, unknown>;
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

describe('Cloud Functions deployed surface', async () => {
  const fns = await loadFunctions({ APP_ENV: undefined, GCLOUD_PROJECT: undefined });
  type Endpoint = Record<string, any>;
  const endpoint = (name: string) => (fns[name] as { __endpoint: Endpoint }).__endpoint;

  it('exports exactly api, tick, watchdog and retention', () => {
    const deployed = Object.entries(fns).filter(([, v]) => typeof v === 'function' && '__endpoint' in (v as object)).map(([k]) => k).sort();
    expect(deployed).toEqual(['api', 'retention', 'tick', 'watchdog']);
  });

  it('loads without initializing Firebase', () => {
    expect(getApps()).toHaveLength(0);
  });

  it('only the API is publicly invokable', () => {
    expect(endpoint('api').httpsTrigger.invoker).toEqual(['public']);
    for (const name of ['tick', 'watchdog', 'retention']) {
      const e = endpoint(name);
      expect(e.httpsTrigger, name).toBeUndefined();
      expect(JSON.stringify(e)).not.toContain('public');
    }
  });

  it('only the backend service account may enqueue or invoke deadline wake-ups', () => {
    expect(endpoint('tick').taskQueueTrigger.invoker).toEqual(['manhunt-backend@']);
  });

  it('every function runs as the backend service account, never the default compute account', () => {
    for (const name of ['api', 'tick', 'watchdog', 'retention']) expect(endpoint(name).serviceAccountEmail, name).toBe('manhunt-backend@');
  });

  it('spells the account out in full when the CLI provides the project (Cloud Scheduler rejects the shorthand)', async () => {
    const deployFns = await loadFunctions({ APP_ENV: undefined, GCLOUD_PROJECT: 'manhunt-example-prod' });
    const full = 'manhunt-backend@manhunt-example-prod.iam.gserviceaccount.com';
    for (const name of ['api', 'tick', 'watchdog', 'retention']) {
      expect((deployFns[name] as { __endpoint: Endpoint }).__endpoint.serviceAccountEmail, name).toBe(full);
    }
    expect((deployFns.tick as { __endpoint: Endpoint }).__endpoint.taskQueueTrigger.invoker).toEqual([full]);
  });

  it('scheduled jobs keep their cadence', () => {
    expect(endpoint('watchdog').scheduleTrigger).toMatchObject({ schedule: '* * * * *', timeZone: 'Etc/UTC' });
    expect(endpoint('retention').scheduleTrigger).toMatchObject({ schedule: '17 4 * * *', timeZone: 'Etc/UTC' });
  });
});
