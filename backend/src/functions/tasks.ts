import type { FastifyBaseLogger } from 'fastify';
import { HttpsError } from 'firebase-functions/v2/https';
import { AppError } from '../domain/errors.js';
import type { GameService } from '../services/gameService.js';
import { TickBody } from '../worker/jobs.js';

export interface TickTaskRequest {
  data: unknown;
  /** claims of the OIDC token Cloud Tasks presented (absent in the emulator) */
  auth?: { token?: { email?: unknown } } | undefined;
}

export interface TickTaskOptions {
  game: Pick<GameService, 'tick'>;
  /** service accounts allowed to deliver tasks; null skips the check (emulator only) */
  allowedCallers: string[] | null;
  log: FastifyBaseLogger;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Longest early arrival the handler waits out in-process (the function timeout is 90 s). */
export const EARLY_WAIT_MAX_MS = 30_000;

/**
 * Body of the deployed `tick` task-queue function. Cloud Run IAM has already
 * required a Google-signed OIDC token from an identity with `run.invoker`;
 * this also checks that it is the backend's own service account, which is the
 * identity the Admin SDK enqueues as. Firebase client tokens never get here.
 *
 * A non-2xx makes Cloud Tasks retry, so only failures a retry can fix throw.
 *
 * Cloud Tasks never dispatches before `scheduleTime`, but a wake-up that ran
 * before its deadline would find nothing due and, its task id being spent, not
 * be rescheduled until the watchdog. So an early task waits out a short gap
 * (clock skew) and asks for a retry otherwise. This also makes the Cloud Tasks
 * emulator, which ignores `scheduleTime`, deliver on time for short rules.
 */
export async function runTickTask(req: TickTaskRequest, opts: TickTaskOptions): Promise<void> {
  if (opts.allowedCallers) {
    const email = req.auth?.token?.email;
    if (typeof email !== 'string' || !opts.allowedCallers.includes(email)) {
      opts.log.error({ caller: typeof email === 'string' ? email : null }, 'tick task from an unexpected caller refused');
      throw new HttpsError('permission-denied', 'Caller is not the backend service account');
    }
  }
  const parsed = TickBody.safeParse(req.data);
  if (!parsed.success) {
    opts.log.error({ issues: parsed.error.issues.length }, 'malformed tick task dropped');
    return;
  }
  const early = (parsed.data.at ?? 0) - opts.now();
  if (early > EARLY_WAIT_MAX_MS) throw new HttpsError('unavailable', 'Delivered before its deadline; retry later');
  if (early > 0) await (opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(early);
  try {
    await opts.game.tick(parsed.data.sessionId, parsed.data.roundId);
  } catch (e) {
    // The night or round was deleted after the wake-up was scheduled.
    if (e instanceof AppError && e.code === 'NOT_FOUND') {
      opts.log.info({ roundId: parsed.data.roundId }, 'tick task for a deleted round dropped');
      return;
    }
    throw e;
  }
}
