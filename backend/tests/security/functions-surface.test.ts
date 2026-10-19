import { getApps } from 'firebase-admin/app';
import { describe, expect, it } from 'vitest';

/**
 * Deployed surface (`firebase deploy` reads each export's `__endpoint`): only
 * the API is public; the deadline worker and scheduled jobs are private and
 * run as the least-privilege backend account. Loading the module must not
 * initialize Firebase or need runtime config (deploy-time discovery).
 */
describe('Cloud Functions deployed surface', async () => {
  const savedEnv = process.env.APP_ENV;
  delete process.env.APP_ENV;
  const fns = (await import('../../src/functions/index.js')) as Record<string, unknown>;
  process.env.APP_ENV = savedEnv;
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

  it('scheduled jobs keep their cadence', () => {
    expect(endpoint('watchdog').scheduleTrigger).toMatchObject({ schedule: '* * * * *', timeZone: 'Etc/UTC' });
    expect(endpoint('retention').scheduleTrigger).toMatchObject({ schedule: '17 4 * * *', timeZone: 'Etc/UTC' });
  });
});
