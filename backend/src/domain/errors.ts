export type ErrorCode =
  | 'GAME_NOT_READY'
  | 'STALE_PHASE'
  | 'GPS_UNAVAILABLE'
  | 'PERMISSION_REQUIRED'
  | 'ALREADY_CLAIMED'
  | 'CAPTURE_EXPIRED'
  | 'LOCATION_STALE'
  | 'OPERATOR_NOT_AUTHORIZED'
  | 'GAME_CLOSED'
  | 'RATE_LIMITED'
  | 'RETRYABLE_TEMPORARY'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INVITE_INVALID'
  | 'CONSENT_REQUIRED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA';

const STATUS: Record<ErrorCode, number> = {
  GAME_NOT_READY: 409,
  STALE_PHASE: 409,
  GPS_UNAVAILABLE: 412,
  PERMISSION_REQUIRED: 412,
  ALREADY_CLAIMED: 409,
  CAPTURE_EXPIRED: 410,
  LOCATION_STALE: 412,
  OPERATOR_NOT_AUTHORIZED: 403,
  GAME_CLOSED: 409,
  RATE_LIMITED: 429,
  RETRYABLE_TEMPORARY: 503,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  FORBIDDEN: 403,
  INVITE_INVALID: 410,
  CONSENT_REQUIRED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, details);
}
