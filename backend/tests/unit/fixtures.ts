import { createRound } from '../../src/domain/engine.js';
import { DEFAULT_RULES } from '../../src/domain/rules.js';
import type { CaptureClaim, DeviceHealth, GpsPoint, MemberDoc, Rules, SessionDoc } from '../../src/domain/types.js';

export const HIDER = 'uid-hider-morgan';
export const SEEKER = 'uid-seeker-taylor';
export const T0 = Date.UTC(2026, 9, 17, 20, 0, 0); // 8:00 PM UTC
export const MIN = 60_000;

export function session(rules: Partial<Rules> = {}): SessionDoc {
  return {
    id: 'sess1',
    title: 'Friday Manhunt',
    scheduledDate: '2026-10-17',
    hostUid: HIDER,
    status: 'LOBBY',
    rules: { ...DEFAULT_RULES, ...rules },
    teams: {
      A: {
        teamId: 'teamA',
        key: 'A',
        name: 'Crew A',
        color: '#1E88E5',
        operatorUid: HIDER,
        operatorDisplayName: 'Morgan',
        roster: [
          { personId: 'p-morgan', displayName: 'Morgan' },
          { personId: 'p-casey', displayName: 'Casey' },
          { personId: 'p-jules', displayName: 'Jules' },
        ],
      },
      B: {
        teamId: 'teamB',
        key: 'B',
        name: 'Crew B',
        color: '#F4511E',
        operatorUid: SEEKER,
        operatorDisplayName: 'Taylor',
        roster: [
          { personId: 'p-taylor', displayName: 'Taylor' },
          { personId: 'p-riley', displayName: 'Riley' },
          { personId: 'p-sam', displayName: 'Sam' },
        ],
      },
    },
    memberUids: [HIDER, SEEKER],
    participantPersonIds: ['p-morgan', 'p-casey', 'p-jules', 'p-taylor', 'p-riley', 'p-sam'],
    groupId: null,
    currentRoundId: null,
    roundIds: [],
    completedRoundCount: 0,
    keepPhotos: { A: false, B: false },
    roundBriefs: [],
    revokedAt: null,
    createdAt: T0 - 10 * MIN,
    updatedAt: T0 - 10 * MIN,
    version: 1,
  };
}

export function readyRound(rules: Partial<Rules> = {}) {
  const s = session(rules);
  const { round } = createRound({ id: 'round1', session: s, index: 1, hidingTeam: 'A', suggestedHidingTeam: 'A', overrideByUid: null, overrideReason: null, now: T0 - MIN });
  round.ready = { A: { uid: HIDER, at: T0 - 30_000 }, B: { uid: SEEKER, at: T0 - 20_000 } };
  return { session: s, round };
}

let seq = 0;
export function point(over: Partial<GpsPoint> & { recordedAt: number }): GpsPoint {
  seq++;
  return {
    pointId: over.pointId ?? `pt-${seq}`,
    sessionId: 'sess1',
    roundId: 'round1',
    operatorUid: HIDER,
    teamKey: 'A',
    role: 'HIDING',
    deviceRecordedAt: over.recordedAt,
    receivedAt: over.receivedAt ?? over.recordedAt + 2000,
    latitude: 39.7392 + seq * 1e-5,
    longitude: -104.9903,
    horizontalAccuracyMeters: 8,
    speedMetersPerSecond: null,
    courseDegrees: null,
    qualityFlags: [],
    batchId: 'b1',
    ...over,
  };
}

export function claim(over: Partial<CaptureClaim> = {}): CaptureClaim {
  return {
    claimId: 'claim1',
    sessionId: 'sess1',
    roundId: 'round1',
    seekerUid: SEEKER,
    seekerTeam: 'B',
    status: 'UPLOADING',
    createdAt: T0,
    uploadExpiresAt: T0 + 10 * MIN,
    imageObjectKey: 'sessions/sess1/rounds/round1/captures/claim1.jpg',
    photoStoredAt: T0,
    photoSha256: 'abc',
    photoBytes: 1000,
    submittedAt: null,
    expiresAt: null,
    officialChaseMsAtClaim: null,
    reviewedByUid: null,
    reviewedAt: null,
    rejectionReason: null,
    photoDeletedAt: null,
    dispute: null,
    ...over,
  };
}

export function health(over: Partial<DeviceHealth> = {}): DeviceHealth {
  return {
    lastHeartbeatAt: T0,
    lastSampleRecordedAt: T0,
    lastSampleAccuracyMeters: 8,
    permission: 'WHEN_IN_USE',
    preciseLocation: true,
    trackingActive: true,
    backgroundSessionActive: true,
    lowPowerMode: false,
    batteryLevel: 0.8,
    networkReachable: true,
    appVersion: '0.1.0',
    queuedSamples: 0,
    ...over,
  };
}

export function members(): Record<string, MemberDoc> {
  const base = (uid: string, teamKey: 'A' | 'B', isHost: boolean): MemberDoc => ({
    uid,
    sessionId: 'sess1',
    teamKey,
    isHost,
    active: true,
    joinedAt: T0 - 10 * MIN,
    consent: { acceptedAt: T0 - 9 * MIN, version: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true },
    consentRevokedAt: null,
    health: health(),
    displayName: uid,
  });
  return { [HIDER]: base(HIDER, 'A', true), [SEEKER]: base(SEEKER, 'B', false) };
}
