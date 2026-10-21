import { createRound } from '../../src/domain/engine.js';
import { DEFAULT_RULES } from '../../src/domain/rules.js';
import { operatorUidsOf, roundTeams } from '../../src/domain/crews.js';
import type { CaptureClaim, DeviceHealth, GpsPoint, MemberDoc, Rules, SeekMode, SessionDoc, TeamKey } from '../../src/domain/types.js';

export const HIDER = 'uid-hider-morgan';
export const HIDER2 = 'uid-hider-casey';
export const SEEKER = 'uid-seeker-taylor';
export const SEEKER2 = 'uid-seeker-riley';
export const SEEKER_C = 'uid-seeker-c-alex';
export const T0 = Date.UTC(2026, 9, 17, 20, 0, 0); // 8:00 PM UTC
export const MIN = 60_000;

export interface NightOpts {
  /** add a third crew C (one phone, SEEKER_C) */
  three?: boolean;
  /** crew A's phones (default [HIDER]) */
  phonesA?: string[];
  /** crew B's phones (default [SEEKER]) */
  phonesB?: string[];
}

export function session(rules: Partial<Rules> = {}, opts: NightOpts = {}): SessionDoc {
  const phonesA = opts.phonesA ?? [HIDER];
  const phonesB = opts.phonesB ?? [SEEKER];
  const s: SessionDoc = {
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
        operatorUids: phonesA,
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
        operatorUids: phonesB,
        roster: [
          { personId: 'p-taylor', displayName: 'Taylor' },
          { personId: 'p-riley', displayName: 'Riley' },
          { personId: 'p-sam', displayName: 'Sam' },
        ],
      },
    },
    memberUids: [...phonesA, ...phonesB],
    participantPersonIds: ['p-morgan', 'p-casey', 'p-jules', 'p-taylor', 'p-riley', 'p-sam'],
    groupId: null,
    currentRoundId: null,
    roundIds: [],
    completedRoundCount: 0,
    keepPhotos: {},
    joinCode: 'NIGHTCODE',
    roundBriefs: [],
    revokedAt: null,
    createdAt: T0 - 10 * MIN,
    updatedAt: T0 - 10 * MIN,
    version: 1,
  };
  if (opts.three) {
    s.teams.C = { teamId: 'teamC', key: 'C', name: 'Crew C', color: '#43A047', operatorUids: [SEEKER_C], roster: [{ personId: 'p-alex', displayName: 'Alex' }] };
    s.memberUids.push(SEEKER_C);
    s.participantPersonIds.push('p-alex');
  }
  return s;
}

/** A READY round with every crew marked ready (first phone of each crew). */
export function readyRound(rules: Partial<Rules> = {}, opts: NightOpts & { seekMode?: SeekMode; hidingTeam?: TeamKey } = {}) {
  const s = session(rules, opts);
  const { round } = createRound({ id: 'round1', session: s, index: 1, hidingTeam: opts.hidingTeam ?? 'A', seekMode: opts.seekMode ?? 'TOGETHER', actorUid: HIDER, now: T0 - MIN });
  round.ready = Object.fromEntries(roundTeams(round).map((k, i) => [k, { uid: s.teams[k]!.operatorUids[0]!, at: T0 - 30_000 + i * 1000 }]));
  return { session: s, round };
}

/** Every operator phone of the night, as start eligibility. */
export const allPhones = (s: SessionDoc) => new Set(operatorUidsOf(s));

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

export function members(s: SessionDoc = session()): Record<string, MemberDoc> {
  const out: Record<string, MemberDoc> = {};
  for (const k of ['A', 'B', 'C'] as const) {
    for (const uid of s.teams[k]?.operatorUids ?? []) {
      out[uid] = {
        uid,
        sessionId: 'sess1',
        teamKey: k,
        isHost: uid === s.hostUid,
        active: true,
        joinedAt: T0 - 10 * MIN,
        consent: { acceptedAt: T0 - 9 * MIN, version: 'v1', routeSharingAfterRound: true, guestDisclosureAcknowledged: true },
        consentRevokedAt: null,
        health: health(),
        displayName: uid.replace(/^uid-/, '').replace(/-/g, ' '),
        selfPersonId: null,
      };
    }
  }
  return out;
}
