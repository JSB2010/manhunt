import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, clearEmulators, consentBody, harness, healthyPreflight, jpegWithExif, MIN, type Harness, type TestUser } from './helpers.js';

/**
 * Nights recorded before crews (one phone per crew, one seeking crew) still sit
 * in production. A night is played over the API, then its stored session, round
 * and pin documents are rewritten into that old shape (types at 21d5e2a^). The
 * nights list, person stats, night analytics, export and delete-my-data must
 * all work on it.
 */
let h: Harness;
let a: TestUser; // host, Owls (A), hides
let b: TestUser; // Wolves (B), seeks
let sid: string;
let rid: string;

const raw = (path: string) => h.deps.db.doc(path);

async function playOneCaughtRound() {
  for (const u of [a, b]) {
    const r = await h.call(u, 'POST', `/v1/sessions/${sid}/ready`, { ready: true, preflight: healthyPreflight() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  rid = (await h.call(a, 'GET', `/v1/sessions/${sid}`)).body.round.id;
  expect((await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/start`, { acknowledgeWarnings: false })).status).toBe(200);
  const T0 = h.clock.now();
  for (const t of [T0 + 2 * MIN, T0 + 4 * MIN]) {
    h.clock.set(t - 4000);
    await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/location-batches`, batch(h.clock, [[t - 5000, 39.74, -104.99]]));
    h.clock.set(t);
    await h.tick(sid, rid);
  }
  h.clock.set(T0 + 5 * MIN);
  const init = await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/init`, {});
  await h.call(b, 'PUT', init.body.uploadPath, jpegWithExif(), { 'content-type': 'image/jpeg' });
  await h.call(b, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/complete`, { claimId: init.body.claimId });
  const ok = await h.call(a, 'POST', `/v1/sessions/${sid}/rounds/${rid}/captures/${init.body.claimId}/decision`, { decision: 'CONFIRM' });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  expect((await h.call(a, 'POST', `/v1/sessions/${sid}/complete`)).status).toBe(200);
}

/** Crew names as typed by the organizer, as nights from before ADR 0019 have them. */
const TYPED: Record<string, string> = { A: 'Owls', B: 'Wolves' };

/** Rewrites the stored night into the pre-crews shape, as old nights are stored in production. */
async function storeAsBeforeCrews() {
  const sRef = raw(`sessions/${sid}`);
  const { joinCode: _code, bench: _bench, ...s } = (await sRef.get()).data()!;
  await sRef.set({
    ...s,
    teams: Object.fromEntries(Object.entries(s.teams).map(([k, { operatorUids, ...t }]: [string, any]) => [k, { ...t, name: TYPED[k], operatorUid: operatorUids[0] ?? null, operatorDisplayName: null }])),
    roundBriefs: s.roundBriefs.map(({ seekingTeams: _s, seekMode: _m, catchCreditTeams: _c, hidingRosterFingerprint: _f, teamNames: _n, ...brief }: any) => brief),
  });

  const rRef = raw(`sessions/${sid}/rounds/${rid}`);
  const { seekingTeams, seekMode: _m, operatorsByTeam, routeSourceUids: _r, waitingPing: _w, pings, result, ...r } = (await rRef.get()).data()!;
  const [hiding, seeking] = [r.hidingTeam as string, seekingTeams[0] as string];
  const { seekingTeams: _rs, seekMode: _rm, teamNames, rosterSnapshot, catchCreditTeams: _cc, crews = {}, ...res } = result;
  await rRef.set({
    ...r,
    teamNames: TYPED,
    seekingTeam: seeking,
    hiderUid: operatorsByTeam[hiding][0] ?? null,
    seekerUid: operatorsByTeam[seeking][0] ?? null,
    pings: pings.map(({ sourceUid: _src, ...p }: any) => p),
    result: {
      ...res,
      seekingTeam: seeking,
      hidingTeamName: TYPED[hiding] ?? teamNames[hiding],
      seekingTeamName: TYPED[seeking] ?? teamNames[seeking],
      hidingRosterSnapshot: rosterSnapshot[hiding],
      seekingRosterSnapshot: rosterSnapshot[seeking],
      hidingDistanceTotalMeters: crews[hiding]?.distanceTotalMeters ?? null,
      hidingDistanceChaseMeters: crews[hiding]?.distanceChaseMeters ?? null,
      seekingDistanceChaseMeters: crews[seeking]?.distanceChaseMeters ?? null,
      gpsCoverageFractionHider: crews[hiding]?.gpsCoverageFraction ?? null,
      gpsCoverageFractionSeeker: crews[seeking]?.gpsCoverageFraction ?? null,
      routeQualityHider: crews[hiding]?.routeQuality ?? 'INSUFFICIENT',
      routeQualitySeeker: crews[seeking]?.routeQuality ?? 'INSUFFICIENT',
    },
  });
  for (const d of (await rRef.collection('pings').get()).docs) {
    const { sourceUid: _src, ...p } = d.data();
    await d.ref.set(p);
  }
  // Views written before crews were schema 1, with no content hash and no seeking crews on their briefs.
  for (const d of (await sRef.collection('views').get()).docs) {
    const { viewHash: _h, previousRounds, ...v } = d.data();
    await d.ref.set({ ...v, schemaVersion: 1, previousRounds: previousRounds.map(({ seekingTeams: _s, seekMode: _m, catchCreditTeams: _c, teamNames: _n, ...brief }: any) => brief) });
  }
}

const releasedPins = async () => {
  const docs = (await raw(`sessions/${sid}/rounds/${rid}`).collection('pings').get()).docs.map((d) => d.data());
  const embedded = (await raw(`sessions/${sid}/rounds/${rid}`).get()).data()!.pings as any[];
  return { docs: docs.filter((p) => p.latitude !== null).length, embedded: embedded.filter((p) => p.latitude !== null).length };
};

beforeAll(async () => {
  await clearEmulators();
  h = await harness();
  a = await h.createUser('Avery');
  b = await h.createUser('Blake');
  const s = await h.call(a, 'POST', '/v1/sessions', {
    title: 'First night',
    scheduledDate: '2026-10-20',
    myTeam: 'A',
    teams: { A: { name: 'Owls', roster: [{ displayName: 'Ana' }] }, B: { name: 'Wolves', roster: [{ displayName: 'Bo' }] } },
    rules: { headStartSeconds: 120, pingIntervalSeconds: 120, maxChaseSeconds: 600, confirmationTimeoutSeconds: 60 },
  });
  sid = s.body.sessionId;
  const inv = await h.call(a, 'POST', `/v1/sessions/${sid}/invites`, {});
  await h.call(b, 'POST', '/v1/invites/redeem', { code: inv.body.code, teamKey: 'B' });
  for (const u of [a, b]) await h.call(u, 'POST', `/v1/sessions/${sid}/consent`, consentBody);
  await playOneCaughtRound();
  await storeAsBeforeCrews();
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('nights recorded before crews', () => {
  it('the nights list loads, with each phone on its crew', async () => {
    for (const [u, crew] of [[a, 'A'], [b, 'B']] as const) {
      const list = await h.call(u, 'GET', '/v1/sessions?limit=20');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.items.find((i: any) => i.id === sid)).toMatchObject({ myTeam: crew, completedRoundCount: 1, teams: { A: { name: 'Owls', phoneCount: 1 }, B: { name: 'Wolves', phoneCount: 1 } } });
    }
    const search = await h.call(a, 'GET', '/v1/sessions?q=wolves');
    expect(search.status).toBe(200);
    expect(search.body.items.map((i: any) => i.id)).toContain(sid);
    // Reads don't rewrite the stored night.
    const stored = (await raw(`sessions/${sid}`).get()).data()!;
    expect(stored.teams.A.operatorUid).toBe(a.uid);
    expect(stored.teams.A.operatorUids).toBeUndefined();
  });

  it("a night's detail renders a current view in place of the old stored one", async () => {
    for (const [u, crew] of [[a, 'A'], [b, 'B']] as const) {
      const v = await h.call(u, 'GET', `/v1/sessions/${sid}`);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body).toMatchObject({ schemaVersion: 2, uid: u.uid, session: { myTeam: crew } });
      expect(v.body.previousRounds).toEqual([expect.objectContaining({ roundId: rid, hidingTeam: 'A', seekingTeams: ['B'], catchCreditTeams: ['B'] })]);
    }
  });

  it("person stats, the night's analytics and the export include the old round, attributed to crews", async () => {
    const people = await h.call(a, 'GET', '/v1/people?q=bo');
    const bo = people.body.people.find((p: any) => p.displayName === 'Bo');
    const stats = await h.call(a, 'GET', `/v1/analytics/people/${bo.id}`);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.analytics).toMatchObject({ attribution: 'CREW_LEVEL', roundsCrewHid: 0, roundsCrewSought: 1 });

    const night = await h.call(b, 'GET', `/v1/sessions/${sid}/analytics`);
    expect(night.status, JSON.stringify(night.body)).toBe(200);
    expect(night.body.playedRounds).toBe(1);
    expect(night.body.scorecard.rounds[0]).toMatchObject({ hidingTeam: 'A', seekingTeams: ['B'], catchCreditTeams: ['B'], outcome: 'CAUGHT' });

    const csv = await h.call(a, 'GET', `/v1/export/sessions/${sid}.csv`);
    expect(csv.status).toBe(200);
    expect(csv.body.split('\n')[1]).toContain('Owls,Wolves,TOGETHER,Wolves');
  });

  it("delete my data redacts the lone hider's pins, and only theirs", async () => {
    const before = await releasedPins();
    expect(before.docs).toBeGreaterThan(0);
    expect(before.embedded).toBeGreaterThan(0);

    const seeker = await h.call(b, 'DELETE', `/v1/sessions/${sid}/my-data`);
    expect(seeker.status, JSON.stringify(seeker.body)).toBe(200);
    expect(await releasedPins()).toEqual(before);

    const hider = await h.call(a, 'DELETE', `/v1/sessions/${sid}/my-data`);
    expect(hider.status, JSON.stringify(hider.body)).toBe(200);
    expect(await releasedPins()).toEqual({ docs: 0, embedded: 0 });
  });
});
