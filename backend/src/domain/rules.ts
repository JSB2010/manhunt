import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Rules, SeekMode } from './types.js';

export const DEFAULT_RULES: Rules = {
  headStartSeconds: 600,
  pingIntervalSeconds: 600,
  visiblePingHistoryCount: 1,
  maxChaseSeconds: null,
  confirmationTimeoutSeconds: 120,
  manualPausesEnabled: true,
  maxPingGpsAgeSeconds: 60,
  maxPingAccuracyMeters: 50,
};

/** Validation ranges from spec §4. */
export const RulesSchema = z
  .object({
    headStartSeconds: z.number().int().min(0).max(3600),
    pingIntervalSeconds: z.number().int().min(60).max(3600),
    visiblePingHistoryCount: z.number().int().min(1).max(50).nullable(),
    maxChaseSeconds: z
      .number()
      .int()
      .min(5 * 60)
      .max(360 * 60)
      .nullable(),
    confirmationTimeoutSeconds: z.number().int().min(30).max(600),
    manualPausesEnabled: z.boolean(),
    maxPingGpsAgeSeconds: z.number().int().min(10).max(300),
    maxPingAccuracyMeters: z.number().int().min(5).max(200),
  })
  .strict();

export const RulesPatchSchema = RulesSchema.partial();

export function mergeRules(base: Rules, patch: Partial<Rules> | undefined): Rules {
  const merged = { ...base, ...(patch ?? {}) };
  return RulesSchema.parse(merged);
}

/**
 * Fingerprint of everything that affects whether two chase times are
 * comparable: the timing rules, plus how many crews were seeking and whether
 * they raced (two cars racing find hiders differently from one).
 */
export function rulesFingerprint(r: Rules, seekingCrews = 1, seekMode: SeekMode = 'TOGETHER'): string {
  const material = [
    r.headStartSeconds,
    r.pingIntervalSeconds,
    r.visiblePingHistoryCount ?? 'all',
    r.maxChaseSeconds ?? 'none',
    r.maxPingGpsAgeSeconds,
    r.maxPingAccuracyMeters,
    // Single-seeker rounds keep the v1 material so their fingerprints are unchanged.
    ...(seekingCrews > 1 ? [`seekers:${seekingCrews}`, seekMode] : []),
  ].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
