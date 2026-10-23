import { HttpsError } from 'firebase-functions/v2/https';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import { EARLY_WAIT_MAX_MS, runTickTask } from '../../src/functions/tasks.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/observability/logger.js';
import { TaskQueueScheduler, taskName, WAKE_LEAD_MS, type WakeTask } from '../../src/services/scheduler.js';

process.env.APP_ENV = 'test';
const log = createLogger(loadConfig({ env: 'test', projectId: 'demo-manhunt' }), 'functions-tasks');
const BACKEND = 'manhunt-backend@demo-manhunt.iam.gserviceaccount.com';
const data = { sessionId: 's1', roundId: 'r1', generation: 2, eventKey: 'ping-3', at: 1_000 };
const now = () => 1_000;

describe('tick task handler', () => {
  it('ticks the round when the backend service account delivers the task', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    await runTickTask({ data, auth: { token: { email: BACKEND } } }, { game, allowedCallers: [BACKEND], log, now });
    expect(game.tick).toHaveBeenCalledWith('s1', 'r1');
  });

  it('refuses any other identity, or none, without ticking', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    for (const auth of [{ token: { email: 'someone@other-project.iam.gserviceaccount.com' } }, { token: { email: 'player@example.com' } }, { token: {} }, undefined]) {
      await expect(runTickTask({ data, auth }, { game, allowedCallers: [BACKEND], log, now })).rejects.toBeInstanceOf(HttpsError);
    }
    expect(game.tick).not.toHaveBeenCalled();
  });

  it('drops malformed payloads instead of letting Cloud Tasks retry them', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    for (const bad of [null, {}, { sessionId: 's1' }, { ...data, latitude: 39.7 }]) {
      await runTickTask({ data: bad, auth: { token: { email: BACKEND } } }, { game, allowedCallers: [BACKEND], log, now });
    }
    expect(game.tick).not.toHaveBeenCalled();
  });

  it('drops wake-ups for deleted rounds but rethrows failures a retry can fix', async () => {
    const gone = { tick: vi.fn(async () => Promise.reject(new AppError('NOT_FOUND', 'Round not found'))) };
    await expect(runTickTask({ data }, { game: gone, allowedCallers: null, log, now })).resolves.toBeUndefined();
    const contended = { tick: vi.fn(async () => Promise.reject(Object.assign(new Error('ABORTED'), { code: 10 }))) };
    await expect(runTickTask({ data }, { game: contended, allowedCallers: null, log, now })).rejects.toThrow('ABORTED');
  });
});

describe('tick task delivered before its deadline', () => {
  it('waits out a short early arrival, then ticks', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    const sleep = vi.fn(async () => undefined);
    await runTickTask({ data: { ...data, at: 5_000 } }, { game, allowedCallers: null, log, now, sleep });
    expect(sleep).toHaveBeenCalledWith(4_000);
    expect(game.tick).toHaveBeenCalledTimes(1);
  });

  it('asks Cloud Tasks to retry a long-early arrival instead of spending the wake-up', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    const sleep = vi.fn(async () => undefined);
    const err = await runTickTask({ data: { ...data, at: 1_000 + EARLY_WAIT_MAX_MS + 1 } }, { game, allowedCallers: null, log, now, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).httpErrorCode.status).toBeGreaterThanOrEqual(500);
    expect(sleep).not.toHaveBeenCalled();
    expect(game.tick).not.toHaveBeenCalled();
  });

  it('ticks immediately when on time, late, or when no deadline is given', async () => {
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    const sleep = vi.fn(async () => undefined);
    const { at: _at, ...noDeadline } = data;
    for (const d of [data, { ...data, at: 500 }, noDeadline]) await runTickTask({ data: d }, { game, allowedCallers: null, log, now, sleep });
    expect(sleep).not.toHaveBeenCalled();
    expect(game.tick).toHaveBeenCalledTimes(3);
  });
});

describe('task-queue scheduler', () => {
  const wake: WakeTask = { sessionId: 's1', roundId: 'r1', generation: 2, eventKey: 'ping-3', at: Date.UTC(2026, 9, 18, 20, 1, 0, 250) };

  it('targets the tick function in the configured region', () => {
    const cfg = loadConfig({ env: 'test', projectId: 'demo-manhunt', tasksLocation: 'europe-west1', tasksFunction: 'tick' });
    expect(TaskQueueScheduler.functionPath(cfg)).toBe('locations/europe-west1/functions/tick');
  });

  it('enqueues ids only, a cold start ahead of the deadline, under a deterministic task id', async () => {
    const queue = { enqueue: vi.fn(async () => undefined) };
    await new TaskQueueScheduler(queue, log).scheduleWake(wake);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    const [payload, opts] = queue.enqueue.mock.calls[0] as unknown as [Record<string, unknown>, { id: string; scheduleTime: Date }];
    // The payload keeps the deadline itself: the handler waits until then, so selection never runs early.
    expect(payload).toEqual({ sessionId: 's1', roundId: 'r1', generation: 2, eventKey: 'ping-3', at: wake.at });
    expect(opts.id).toBe(taskName(wake));
    expect(opts.scheduleTime.getTime()).toBe(wake.at - WAKE_LEAD_MS);
  });

  it('dispatches early by less than the handler waits out, so an early wake-up is never retried', async () => {
    expect(WAKE_LEAD_MS).toBeGreaterThan(0);
    expect(WAKE_LEAD_MS).toBeLessThan(EARLY_WAIT_MAX_MS);
    const game = { tick: vi.fn(async () => ({ processed: [] })) };
    const sleep = vi.fn(async () => undefined);
    await runTickTask({ data: { ...data, at: 1_000 + WAKE_LEAD_MS } }, { game, allowedCallers: null, log, now, sleep });
    expect(sleep).toHaveBeenCalledWith(WAKE_LEAD_MS);
    expect(game.tick).toHaveBeenCalledTimes(1);
  });

  it('treats a duplicate id as success and never throws on enqueue failure (the watchdog repairs)', async () => {
    const duplicate = { enqueue: vi.fn(async () => Promise.reject(Object.assign(new Error('exists'), { code: 'functions/task-already-exists' }))) };
    await expect(new TaskQueueScheduler(duplicate, log).scheduleWake(wake)).resolves.toBeUndefined();
    const down = { enqueue: vi.fn(async () => Promise.reject(new Error('UNAVAILABLE'))) };
    await expect(new TaskQueueScheduler(down, log).scheduleWake(wake)).resolves.toBeUndefined();
  });
});
