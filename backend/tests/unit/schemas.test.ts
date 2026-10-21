import { describe, expect, it } from 'vitest';
import { CreateSessionBody, HealthInput, LocationBatchBody, NextRoundBody, parse, RedeemInviteBody, SetupPatchBody } from '../../src/schemas/api.js';

/** iOS (Swift JSONEncoder) omits nil optionals; the API must accept that shape. */
describe('request schemas accept the iOS client encoding', () => {
  const swiftHealth = { permission: 'WHEN_IN_USE', preciseLocation: true, trackingActive: false, backgroundSessionActive: false, lowPowerMode: false, networkReachable: true, queuedSamples: 0 };

  it('health with omitted nullable fields parses and normalizes to null', () => {
    const h = parse(HealthInput, swiftHealth);
    expect(h.batteryLevel).toBeNull();
    expect(h.lastFixAgeSeconds).toBeNull();
    expect(h.appVersion).toBeNull();
  });

  it('location batch with omitted optional sample fields parses; unknown keys still rejected', () => {
    const body = {
      batchId: '7a0b3c55-2d6f-4a39-9a9e-2f1b8e0c4d11',
      sentAt: '2026-10-18T05:00:00.000Z',
      samples: [{ pointId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', recordedAt: '2026-10-18T04:59:59.000Z', latitude: 39.7, longitude: -104.9, horizontalAccuracyMeters: 5 }],
      health: swiftHealth,
    };
    expect(parse(LocationBatchBody, body).samples).toHaveLength(1);
    expect(() => parse(LocationBatchBody, { ...body, role: 'HIDING' })).toThrow();
  });
});

describe('crew request schemas', () => {
  const team = { name: 'Crew', roster: [{ displayName: 'Ana' }] };

  it('a night takes two or three crews; myTeam and the first hider must be one of them', () => {
    expect(parse(CreateSessionBody, { title: 't', scheduledDate: '2026-10-20', myTeam: 'C', teams: { A: team, B: team, C: team }, seekMode: 'RACE' }).teams.C).toBeTruthy();
    expect(() => parse(CreateSessionBody, { title: 't', scheduledDate: '2026-10-20', myTeam: 'C', teams: { A: team, B: team } })).toThrow();
    expect(() => parse(CreateSessionBody, { title: 't', scheduledDate: '2026-10-20', myTeam: 'A', firstHidingTeam: 'C', teams: { A: team, B: team } })).toThrow();
    expect(() => parse(CreateSessionBody, { title: 't', scheduledDate: '2026-10-20', myTeam: 'A', teams: { A: team, B: team, D: team } })).toThrow();
    expect(() => parse(CreateSessionBody, { title: 't', scheduledDate: '2026-10-20', myTeam: 'A', teams: { A: team, B: team }, rules: { totalRounds: 4 } })).toThrow();
  });

  it('setup edits take crew removal and phone moves, never operator lists', () => {
    expect(parse(SetupPatchBody, { teams: { C: null }, moves: [{ uid: 'u1', teamKey: 'B' }, { uid: 'u2', teamKey: null }] }).moves).toHaveLength(2);
    expect(() => parse(SetupPatchBody, { teams: { A: { operatorUids: ['x'] } } })).toThrow();
    expect(() => parse(SetupPatchBody, { moves: [{ uid: 'u1', teamKey: 'D' }] })).toThrow();
  });

  it('next round takes a hiding crew and a seek mode only', () => {
    expect(parse(NextRoundBody, { hidingTeam: 'C', seekMode: 'TOGETHER' })).toEqual({ hidingTeam: 'C', seekMode: 'TOGETHER' });
    expect(() => parse(NextRoundBody, { overrideReason: 'x' })).toThrow();
  });

  it('redeem takes a code or an invite id, plus an optional crew', () => {
    expect(parse(RedeemInviteBody, { code: 'ABCD2345', teamKey: 'B' }).teamKey).toBe('B');
    expect(() => parse(RedeemInviteBody, { code: 'ABCD2345', inviteId: 'x' })).toThrow();
  });
});
