import type { FastifyBaseLogger } from 'fastify';
import type { TaskOptions } from 'firebase-admin/functions';
import type { Config } from '../config.js';
import type { TickPayload } from '../worker/jobs.js';

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

const payload = (t: WakeTask): TickPayload => ({ sessionId: t.sessionId, roundId: t.roundId, generation: t.generation, eventKey: t.eventKey, at: t.at });

/** The part of firebase-admin's `TaskQueue` this scheduler uses. */
export interface WakeQueue {
  enqueue(data: TickPayload, opts?: TaskOptions): Promise<void>;
}

/**
 * Production: enqueue onto the Cloud Tasks queue that Firebase creates for the
 * `tick` task-queue function. Cloud Tasks calls the function with an OIDC
 * token for the backend service account at `at`.
 */
export class TaskQueueScheduler implements Scheduler {
  constructor(
    private queue: WakeQueue,
    private log: FastifyBaseLogger,
  ) {}

  static functionPath(cfg: Config) {
    return `locations/${cfg.tasksLocation}/functions/${cfg.tasksFunction}`;
  }

  async scheduleWake(t: WakeTask): Promise<void> {
    try {
      // Deterministic id → Cloud Tasks deduplicates retries of the same schedule call.
      await this.queue.enqueue(payload(t), { id: taskName(t), scheduleTime: new Date(t.at) });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'functions/task-already-exists') return;
      this.log.error({ err: e, roundId: t.roundId, eventKey: t.eventKey }, 'task enqueue failed; watchdog will repair');
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
          body: JSON.stringify(payload(t)),
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
