import { CloudTasksClient } from '@google-cloud/tasks';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';

/**
 * Server-side deadline scheduling (spec §5.4). One wake-up task per
 * (round, generation, event). Correctness never depends on a task arriving:
 * the worker tick is idempotent and the watchdog repairs missed wake-ups.
 */
export interface WakeTask {
  sessionId: string;
  roundId: string;
  generation: number;
  eventKey: string;
  at: number;
}

export interface Scheduler {
  scheduleWake(task: WakeTask): Promise<void>;
  close?(): void;
}

export const taskName = (t: WakeTask) => `r-${t.roundId}-g${t.generation}-${t.eventKey}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 500);

export class CloudTasksScheduler implements Scheduler {
  private client = new CloudTasksClient();
  constructor(
    private cfg: Config,
    private log: FastifyBaseLogger,
  ) {}

  async scheduleWake(t: WakeTask): Promise<void> {
    const parent = this.client.queuePath(this.cfg.projectId, this.cfg.tasksLocation, this.cfg.tasksQueue);
    const body = Buffer.from(JSON.stringify({ sessionId: t.sessionId, roundId: t.roundId, generation: t.generation, eventKey: t.eventKey, at: t.at })).toString('base64');
    try {
      await this.client.createTask({
        parent,
        task: {
          // Deterministic name → Cloud Tasks deduplicates retries of the same schedule call.
          name: `${parent}/tasks/${taskName(t)}`,
          scheduleTime: { seconds: Math.floor(t.at / 1000), nanos: (t.at % 1000) * 1e6 },
          httpRequest: {
            httpMethod: 'POST',
            url: `${this.cfg.workerUrl}/internal/rounds/tick`,
            headers: { 'Content-Type': 'application/json' },
            body,
            oidcToken: { serviceAccountEmail: this.cfg.tasksInvokerServiceAccount, audience: this.cfg.workerAudience },
          },
        },
      });
    } catch (e: unknown) {
      const code = (e as { code?: number }).code;
      if (code === 6 /* ALREADY_EXISTS */) return;
      this.log.error({ err: e, roundId: t.roundId, eventKey: t.eventKey }, 'cloud task create failed; watchdog will repair');
    }
  }
}

/** Local development: in-process timers that POST to the local worker. Restart-safe via the watchdog. */
export class LocalScheduler implements Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private cfg: Config,
    private log: FastifyBaseLogger,
  ) {}

  async scheduleWake(t: WakeTask): Promise<void> {
    const name = taskName(t);
    if (this.timers.has(name)) return;
    const delay = Math.max(0, t.at - Date.now()) + 25;
    const timer = setTimeout(async () => {
      this.timers.delete(name);
      try {
        const res = await fetch(`${this.cfg.workerUrl}/internal/rounds/tick`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-worker-secret': this.cfg.devWorkerSecret ?? '' },
          body: JSON.stringify({ sessionId: t.sessionId, roundId: t.roundId, generation: t.generation, eventKey: t.eventKey, at: t.at }),
        });
        if (!res.ok) this.log.warn({ status: res.status, task: name }, 'local wake failed');
      } catch (err) {
        this.log.warn({ err, task: name }, 'local wake error; watchdog will repair');
      }
    }, Math.min(delay, 2_147_000_000));
    timer.unref?.();
    this.timers.set(name, timer);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Test scheduler: records requested wake-ups; tests advance time and call the worker. */
export class ManualScheduler implements Scheduler {
  readonly tasks: WakeTask[] = [];
  async scheduleWake(t: WakeTask): Promise<void> {
    if (!this.tasks.some((x) => taskName(x) === taskName(t))) this.tasks.push(t);
  }
}
