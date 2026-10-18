import { describe, expect, it } from 'vitest';
import { HealthInput, LocationBatchBody, parse } from '../../src/schemas/api.js';

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
