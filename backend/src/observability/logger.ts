import pino from 'pino';
import type { Config } from '../config.js';

/**
 * Structured, redacted logging. Request bodies are never logged; known
 * coordinate-bearing keys are censored defensively in case an object with
 * location data is ever passed to the logger.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'latitude',
  'longitude',
  '*.latitude',
  '*.longitude',
  '*.*.latitude',
  '*.*.longitude',
  'samples',
  '*.samples',
  'pings',
  '*.pings',
  'location',
  '*.location',
  'fcmToken',
  '*.fcmToken',
  'code',
];

export function createLogger(cfg: Config, name: string) {
  const level = process.env.LOG_LEVEL ?? (cfg.env === 'test' ? 'silent' : 'info');
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Cloud Logging understands `severity`.
    formatters: { level: (label) => ({ severity: label.toUpperCase(), level: label }) },
    messageKey: 'message',
    base: { service: name, env: cfg.env },
  });
}
