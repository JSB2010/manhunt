import { z } from 'zod';

/**
 * Payload of a deadline wake-up. The same shape travels through the Cloud
 * Tasks queue in production and the local worker's HTTP routes in dev/tests.
 * Only ids — never coordinates.
 */
export const TickBody = z
  .object({ sessionId: z.string().min(1).max(128), roundId: z.string().min(1).max(128), generation: z.number().int().optional(), eventKey: z.string().max(64).optional(), at: z.number().optional() })
  .strict();

export type TickPayload = z.infer<typeof TickBody>;
