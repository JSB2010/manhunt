// Core domain types. Times inside authoritative server documents are epoch
// milliseconds (number) so clock math is exact and cheap. API/view payloads
// convert to ISO-8601 UTC strings at the edge.

/** A night has two or three crews. */
export type TeamKey = 'A' | 'B' | 'C';
export const TEAM_KEYS: readonly TeamKey[] = ['A', 'B', 'C'] as const;
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 3;
/** Equal operator phones a crew may carry; any one of them acts for the crew. */
export const MAX_OPERATORS_PER_TEAM = 5;

export type Role = 'HIDING' | 'SEEKING';
/** Pause/resume authority is between the two sides of a round, not individual crews. */
export type Side = 'HIDERS' | 'SEEKERS';
/** With two seeking crews: share the catch (TOGETHER) or credit the crew that made it (RACE). */
export type SeekMode = 'TOGETHER' | 'RACE';

export type SessionStatus = 'LOBBY' | 'IN_ROUND' | 'BETWEEN_ROUNDS' | 'COMPLETED';

export type RoundState =
  | 'READY'
  | 'HEAD_START'
  | 'CHASE'
  | 'CAPTURE_PENDING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'TIMED_OUT'
  | 'ABORTED';

export const ACTIVE_ROUND_STATES: readonly RoundState[] = ['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'];
export const FINISHED_ROUND_STATES: readonly RoundState[] = ['COMPLETED', 'TIMED_OUT', 'ABORTED'];
export const isActiveState = (s: RoundState) => ACTIVE_ROUND_STATES.includes(s);
export const isFinishedState = (s: RoundState) => FINISHED_ROUND_STATES.includes(s);

export interface Rules {
  headStartSeconds: number;
  pingIntervalSeconds: number;
  /** null = show all released pins */
  visiblePingHistoryCount: number | null;
  /** null = no chase time cap */
  maxChaseSeconds: number | null;
  confirmationTimeoutSeconds: number;
  manualPausesEnabled: boolean;
  maxPingGpsAgeSeconds: number;
  maxPingAccuracyMeters: number;
}

export interface PersonRef {
  personId: string;
  displayName: string;
}

export interface Team {
  teamId: string;
  key: TeamKey;
  name: string;
  color: string;
  /** Operator phones (account uids) on this crew. A uid is on at most one crew. */
  operatorUids: string[];
  roster: PersonRef[];
}

export interface SessionDoc {
  id: string;
  title: string;
  scheduledDate: string; // YYYY-MM-DD
  hostUid: string;
  status: SessionStatus;
  /** Default rules for the next round (each round snapshots its own copy). */
  rules: Rules;
  /** Two or three crews, keyed A, B[, C]. */
  teams: Partial<Record<TeamKey, Team>>;
  memberUids: string[];
  participantPersonIds: string[];
  groupId: string | null;
  currentRoundId: string | null;
  roundIds: string[];
  completedRoundCount: number;
  keepPhotos: Partial<Record<TeamKey, boolean>>;
  /** Reusable night code (server-only); members see it in their view. Null after the night ends. */
  joinCode: string | null;
  /** Small denormalized list of finished rounds for views/history (no coordinates). */
  roundBriefs: RoundBrief[];
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface RoundBrief {
  roundId: string;
  index: number;
  hidingTeam: TeamKey;
  seekingTeams: TeamKey[];
  seekMode: SeekMode;
  /** Crews credited with the catch (attribution only — there is no round winner). */
  catchCreditTeams: TeamKey[];
  outcome: RoundOutcome;
  observedChaseSeconds: number;
  isRightCensored: boolean;
  rulesFingerprint: string;
  /** Fingerprint of the hiding crew's roster this round (detects roster changes between a crew's own hiding rounds). */
  hidingRosterFingerprint: string;
}

export type PermissionStatus = 'NOT_DETERMINED' | 'DENIED' | 'RESTRICTED' | 'WHEN_IN_USE' | 'ALWAYS';

export interface DeviceHealth {
  lastHeartbeatAt: number | null;
  lastSampleRecordedAt: number | null;
  lastSampleAccuracyMeters: number | null;
  permission: PermissionStatus;
  preciseLocation: boolean;
  trackingActive: boolean;
  backgroundSessionActive: boolean;
  lowPowerMode: boolean;
  batteryLevel: number | null;
  networkReachable: boolean;
  appVersion: string | null;
  queuedSamples: number;
}

export interface Consent {
  acceptedAt: number;
  version: string;
  routeSharingAfterRound: boolean;
  guestDisclosureAcknowledged: boolean;
}

export interface MemberDoc {
  uid: string;
  sessionId: string;
  teamKey: TeamKey;
  isHost: boolean;
  active: boolean;
  joinedAt: number;
  consent: Consent | null;
  consentRevokedAt: number | null;
  health: DeviceHealth;
  displayName: string;
  /** the account's own roster person, linking the phone to a roster name */
  selfPersonId: string | null;
  /** content hash of the phone's stored view; views are rewritten only when it changes */
  viewHash?: string | null;
}

export type PauseKind = 'MANUAL' | 'SAFETY' | 'CAPTURE' | 'TECHNICAL';

export interface PauseInterval {
  id: string;
  kind: PauseKind;
  startAt: number;
  endAt: number | null;
  phase: 'HEAD_START' | 'CHASE';
  requestedByUid: string | null;
  confirmedByUid: string | null;
  reason: string | null;
}

export interface PendingPauseRequest {
  id: string;
  byUid: string;
  byTeam: TeamKey;
  bySide: Side;
  at: number;
  expiresAt: number;
  reason: string | null;
}

export type PingStatus = 'RELEASED' | 'NO_FRESH_FIX';

export interface PingRelease {
  index: number;
  scheduledAt: number;
  releasedAt: number;
  status: PingStatus;
  /** true when dispatch latency exceeded the operational delay threshold */
  delayed: boolean;
  dispatchLatencyMs: number;
  observedAt: number | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  ageSeconds: number | null;
  sourcePointId: string | null;
  /** Server-only: which phone the released fix came from (never rendered into views). */
  sourceUid: string | null;
  phaseGeneration: number;
}

export type ClaimStatus = 'UPLOADING' | 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'ABANDONED';

export interface CaptureClaim {
  claimId: string;
  sessionId: string;
  roundId: string;
  seekerUid: string;
  seekerTeam: TeamKey;
  status: ClaimStatus;
  createdAt: number;
  uploadExpiresAt: number;
  imageObjectKey: string;
  photoStoredAt: number | null;
  photoSha256: string | null;
  photoBytes: number | null;
  submittedAt: number | null;
  expiresAt: number | null;
  officialChaseMsAtClaim: number | null;
  reviewedByUid: string | null;
  reviewedAt: number | null;
  rejectionReason: string | null;
  photoDeletedAt: number | null;
  dispute: DisputeState | null;
}

export interface DisputeState {
  /** Settled when the hiding crew and the claimant's crew propose the same resolution. */
  proposals: Partial<Record<TeamKey, { resolution: 'ACCEPT_AS_CATCH' | 'KEEP_REJECTED'; at: number; uid: string }>>;
  resolvedAt: number | null;
  resolution: 'ACCEPT_AS_CATCH' | 'KEEP_REJECTED' | null;
}

export interface ReadyMark {
  uid: string;
  at: number;
}

export type RoundOutcome = 'CAUGHT' | 'TIMED_OUT' | 'ABORTED';

/** Per-crew route statistics for a round. The crew's route is its best-covered phone (a proxy for the crew). */
export interface CrewRouteStats {
  role: Role;
  /** hiders: head start + chase on foot; null for seekers */
  distanceTotalMeters: number | null;
  distanceChaseMeters: number | null;
  gpsCoverageFraction: number | null;
  routeQuality: RouteQuality;
  /** how many of the crew's phones were tracked this round */
  phones: number;
}

export interface RoundResult {
  roundId: string;
  roundIndex: number;
  hidingTeam: TeamKey;
  seekingTeams: TeamKey[];
  seekMode: SeekMode;
  teamNames: Partial<Record<TeamKey, string>>;
  rosterSnapshot: Partial<Record<TeamKey, PersonRef[]>>;
  /** Crews credited with the catch: RACE → the claimant's crew; TOGETHER → every seeking crew; none if not caught. */
  catchCreditTeams: TeamKey[];
  outcome: RoundOutcome;
  headStartSeconds: number;
  observedChaseSeconds: number;
  isRightCensored: boolean;
  officialFoundAt: number | null;
  confirmedAt: number | null;
  claimId: string | null;
  totalPauseSeconds: number;
  roundElapsedSeconds: number;
  pingSlots: number;
  pingsReleased: number;
  pingsMissing: number;
  pingsDelayed: number;
  crews: Partial<Record<TeamKey, CrewRouteStats>>;
  rulesFingerprint: string;
  abortedReason: string | null;
  resolvedByDispute: boolean;
  finalizedAt: number;
}

export type RouteQuality = 'GOOD' | 'ESTIMATED' | 'INSUFFICIENT' | 'DELETED';

export interface RoundDoc {
  id: string;
  sessionId: string;
  index: number;
  state: RoundState;
  pausedFromState: RoundState | null;
  hidingTeam: TeamKey;
  /** every other crew of the night seeks */
  seekingTeams: TeamKey[];
  seekMode: SeekMode;
  /**
   * Operator phones per crew, frozen at start. All in-round authority (uploads,
   * claims, decisions, pauses, ping sources) comes from this snapshot — a phone
   * that joins or moves mid-round is a spectator until the next round.
   */
  operatorsByTeam: Partial<Record<TeamKey, string[]>>;
  rules: Rules;
  teamNames: Partial<Record<TeamKey, string>>;
  rosterSnapshot: Partial<Record<TeamKey, PersonRef[]>>;
  /** one ready mark per crew (any of its phones) */
  ready: Partial<Record<TeamKey, ReadyMark | null>>;
  startWarningsAcknowledged: string[];
  roundStartAt: number | null;
  chaseStartAt: number | null;
  endedAt: number | null;
  phaseGeneration: number;
  pauses: PauseInterval[];
  pendingPauseRequest: PendingPauseRequest | null;
  /** one vote from the hiders and one from the seekers resumes */
  resumeVotes: Partial<Record<Side, number>>;
  nextPingIndex: number;
  pings: PingRelease[];
  /**
   * A ping whose deadline passed with no eligible hider fix. It keeps waiting and
   * releases the hiders' current position as soon as a fresh fix arrives (ADR 0015).
   */
  waitingPing: { index: number; deadline: number; since: number } | null;
  /** Server-only: the phone each crew's route/distance was computed from. */
  routeSourceUids: Partial<Record<TeamKey, string | null>>;
  activeClaimId: string | null;
  claimSubmittedAt: number | null;
  claimExpiresAt: number | null;
  lastClaimOutcome: { claimId: string; status: ClaimStatus; at: number; reason: string | null } | null;
  result: RoundResult | null;
  abortedReason: string | null;
  abortedByUid: string | null;
  /** denormalized flag for collection-group watchdog queries */
  active: boolean;
  /** null while unfinished; false once finished until the recap is computed; true after */
  summaryReady: boolean | null;
  nextWakeAt: number | null;
  lastTickAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface GpsSampleInput {
  pointId: string;
  recordedAt: number; // device clock, ms
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number;
  speedMetersPerSecond?: number | null;
  courseDegrees?: number | null;
  altitudeMeters?: number | null;
}

export interface GpsPoint {
  pointId: string;
  sessionId: string;
  roundId: string;
  operatorUid: string;
  teamKey: TeamKey;
  role: Role;
  /** device timestamp corrected by measured clock offset (server-trusted ordering) */
  recordedAt: number;
  deviceRecordedAt: number;
  receivedAt: number;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number;
  speedMetersPerSecond: number | null;
  courseDegrees: number | null;
  qualityFlags: string[];
  batchId: string;
}

export type AuditEventType =
  | 'SESSION_CREATED'
  | 'OPERATOR_JOINED'
  | 'CONSENT_GIVEN'
  | 'CONSENT_REVOKED'
  | 'SETUP_EDITED'
  | 'READY_CHANGED'
  | 'ROUND_CREATED'
  | 'ROUND_STARTED'
  | 'CHASE_STARTED'
  | 'PING_RELEASED'
  | 'PING_MISSING'
  | 'PING_DELAYED'
  | 'PING_WAITING'
  | 'OPERATOR_MOVED'
  | 'OPERATOR_REMOVED'
  | 'HIDER_PHONES_APART'
  | 'CLAIM_SUBMITTED'
  | 'CLAIM_CONFIRMED'
  | 'CLAIM_REJECTED'
  | 'CLAIM_EXPIRED'
  | 'PAUSE_REQUESTED'
  | 'PAUSE_STARTED'
  | 'RESUME_VOTE'
  | 'RESUMED'
  | 'ROUND_TIMED_OUT'
  | 'ROUND_ABORTED'
  | 'ROUND_FINALIZED'
  | 'SESSION_COMPLETED'
  | 'DISPUTE_PROPOSED'
  | 'DISPUTE_RESOLVED'
  | 'ROUTE_DELETED'
  | 'PHOTO_DELETED'
  | 'SESSION_REVOKED';

/** Audit/timeline event. MUST NOT contain coordinates. */
export interface DomainEvent {
  type: AuditEventType;
  at: number;
  actorUid: string | null;
  roundId: string | null;
  details: Record<string, string | number | boolean | null>;
}

/** Push notification intent produced by domain transitions. MUST NOT contain coordinates. */
export interface NotificationIntent {
  toUids: string[];
  kind: string;
  title: string;
  body: string;
  sessionId: string;
  roundId: string | null;
}
