import { gzipSync } from 'node:zlib';
import { buildRouteSegments, computeDistance, DEFAULT_DISTANCE_OPTIONS, ROLE_MAX_SPEED_MPS, type DistanceResult } from '../domain/geo.js';
import { isFinishedState, type CaptureClaim, type GpsPoint, type RouteQuality, type RoundDoc, type SessionDoc, type TeamKey } from '../domain/types.js';
import { paths, txGet, txMembers, writeViews, type Deps } from './repo.js';

/**
 * Post-round finalization (spec §5.5, §6.1): distance estimates, GPS coverage,
 * simplified route polylines, raw-track archive in GCS and the authorized
 * round summary. Runs after the finishing transition commits; idempotent and
 * retried by the watchdog when `summaryReady === false`.
 */

const SIMPLIFY_TOLERANCE_M = 8;
const MAX_ROUTE_POINTS_PER_TEAM = 4000;

export interface RouteTeam {
  team: TeamKey;
  role: 'HIDING' | 'SEEKING';
  deleted: boolean;
  quality: RouteQuality;
  sampleCount: number;
  segments: { points: { lat: number; lon: number; t: number }[] }[];
}

export interface RouteDoc {
  sessionId: string;
  roundId: string;
  revision: number;
  computedAt: number;
  teams: Record<TeamKey, RouteTeam>;
  markers: {
    roundStartAt: number | null;
    chaseStartAt: number | null;
    officialEndAt: number | null;
    claimPoint: { lat: number; lon: number; t: number } | null;
  };
  deletedTeams: TeamKey[];
}

function quality(d: DistanceResult, samples: number): RouteQuality {
  if (samples < 3 || d.coverageFraction === null) return 'INSUFFICIENT';
  if (d.coverageFraction >= 0.8 && samples >= 10) return 'GOOD';
  if (d.coverageFraction >= 0.25) return 'ESTIMATED';
  return 'INSUFFICIENT';
}

function segmentsFor(samples: GpsPoint[], from: number, to: number, maxSpeed: number) {
  const inWindow = samples.filter((s) => s.recordedAt >= from && s.recordedAt <= to);
  let tolerance = SIMPLIFY_TOLERANCE_M;
  for (;;) {
    const segs = buildRouteSegments(inWindow, { maxAccuracyMeters: DEFAULT_DISTANCE_OPTIONS.maxAccuracyMeters, maxGapSeconds: DEFAULT_DISTANCE_OPTIONS.maxGapSeconds, toleranceMeters: tolerance, maxSpeedMps: maxSpeed });
    const count = segs.reduce((a, s) => a + s.length, 0);
    if (count <= MAX_ROUTE_POINTS_PER_TEAM || tolerance > 200) return segs.map((points) => ({ points }));
    tolerance *= 2;
  }
}

export async function finalizeRound(d: Deps, sid: string, rid: string, opts: { force?: boolean } = {}) {
  const p = paths(d.db);
  const pre = (await p.round(sid, rid).get()).data() as RoundDoc | undefined;
  if (!pre || !isFinishedState(pre.state) || !pre.result) return;
  if (pre.summaryReady === true && !opts.force) return;

  const existingRoute = (await p.route(sid, rid).get()).data() as RouteDoc | undefined;
  const deletedTeams = new Set<TeamKey>(existingRoute?.deletedTeams ?? []);

  const snap = await p.points(sid, rid).get();
  const pts = snap.docs.map((x) => x.data() as GpsPoint);
  const hider = pts.filter((x) => x.operatorUid === pre.hiderUid && x.role === 'HIDING');
  const seeker = pts.filter((x) => x.operatorUid === pre.seekerUid && x.role === 'SEEKING');
  const start = pre.roundStartAt ?? pre.createdAt;
  const officialEnd = pre.result.officialFoundAt ?? pre.endedAt ?? d.clock.now();
  const chaseStart = pre.chaseStartAt ?? officialEnd;
  const base = DEFAULT_DISTANCE_OPTIONS;
  const hTotal = computeDistance(hider, { ...base, from: start, to: officialEnd, maxSpeedMps: ROLE_MAX_SPEED_MPS.HIDING });
  const hChase = computeDistance(hider, { ...base, from: chaseStart, to: officialEnd, maxSpeedMps: ROLE_MAX_SPEED_MPS.HIDING });
  const sChase = computeDistance(seeker, { ...base, from: chaseStart, to: officialEnd, maxSpeedMps: ROLE_MAX_SPEED_MPS.SEEKING });

  const claimsSnap = await p.claims(sid, rid).get();
  const claims = claimsSnap.docs.map((x) => x.data() as CaptureClaim);
  const winningClaim = pre.result.claimId ? claims.find((c) => c.claimId === pre.result!.claimId) : undefined;
  let claimPoint: RouteDoc['markers']['claimPoint'] = null;
  if (winningClaim?.submittedAt && !deletedTeams.has(pre.seekingTeam)) {
    const s = seeker.filter((x) => x.recordedAt <= winningClaim.submittedAt! && x.horizontalAccuracyMeters <= 50).sort((a, b) => b.recordedAt - a.recordedAt)[0];
    if (s && winningClaim.submittedAt - s.recordedAt <= 120_000) claimPoint = { lat: s.latitude, lon: s.longitude, t: s.recordedAt };
  }

  const revision = (existingRoute?.revision ?? 0) + 1;
  const teamRoute = (team: TeamKey, role: 'HIDING' | 'SEEKING', samples: GpsPoint[], dist: DistanceResult): RouteTeam =>
    deletedTeams.has(team)
      ? { team, role, deleted: true, quality: 'DELETED', sampleCount: 0, segments: [] }
      : {
          team,
          role,
          deleted: false,
          quality: quality(dist, samples.length),
          sampleCount: samples.length,
          segments: segmentsFor(samples, start, officialEnd, ROLE_MAX_SPEED_MPS[role]),
        };
  const route: RouteDoc = {
    sessionId: sid,
    roundId: rid,
    revision,
    computedAt: d.clock.now(),
    teams: {
      [pre.hidingTeam]: teamRoute(pre.hidingTeam, 'HIDING', hider, hTotal),
      [pre.seekingTeam]: teamRoute(pre.seekingTeam, 'SEEKING', seeker, sChase),
    } as Record<TeamKey, RouteTeam>,
    markers: { roundStartAt: pre.roundStartAt, chaseStartAt: pre.chaseStartAt, officialEndAt: officialEnd, claimPoint },
    deletedTeams: [...deletedTeams],
  };

  // Raw track archive (private bucket). Only accepted samples, no derived guesses.
  const session = (await p.session(sid).get()).data() as SessionDoc | undefined;
  if (!session) return;
  for (const [team, samples] of [
    [pre.hidingTeam, hider],
    [pre.seekingTeam, seeker],
  ] as const) {
    if (deletedTeams.has(team) || samples.length === 0) continue;
    const geo = {
      type: 'Feature',
      properties: { sessionId: sid, roundId: rid, team, revision },
      geometry: { type: 'LineString', coordinates: [...samples].sort((a, b) => a.recordedAt - b.recordedAt).map((s) => [s.longitude, s.latitude]) },
    };
    const key = `sessions/${sid}/rounds/${rid}/tracks/${session.teams[team].teamId}/${revision}.geojson.gz`;
    await d.store.put(key, gzipSync(Buffer.from(JSON.stringify(geo))), 'application/gzip').catch((err) => d.log.warn({ err }, 'track archive write failed'));
  }

  const eventsSnap = await p.events(sid).where('roundId', '==', rid).get();
  const timeline = eventsSnap.docs
    .map((x) => x.data() as { type: string; at: number; actorUid: string | null; details: Record<string, unknown> })
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ type: e.type, at: e.at, details: e.details }));

  await d.db.runTransaction(async (tx) => {
    const round = await txGet<RoundDoc>(tx, p.round(sid, rid));
    const sess = await txGet<SessionDoc>(tx, p.session(sid));
    if (!round || !round.result || !sess) return;
    const members = await txMembers(tx, d.db, sid);
    const current = sess.currentRoundId && sess.currentRoundId !== rid ? await txGet<RoundDoc>(tx, p.round(sid, sess.currentRoundId)) : null;
    const currentClaim = current?.activeClaimId ? await txGet<CaptureClaim>(tx, p.claim(sid, current.id, current.activeClaimId)) : null;
    const keepHider = deletedTeams.has(round.hidingTeam);
    const keepSeeker = deletedTeams.has(round.seekingTeam);
    const result = {
      ...round.result,
      hidingDistanceTotalMeters: keepHider ? round.result.hidingDistanceTotalMeters : hTotal.meters,
      hidingDistanceChaseMeters: keepHider ? round.result.hidingDistanceChaseMeters : hChase.meters,
      seekingDistanceChaseMeters: keepSeeker ? round.result.seekingDistanceChaseMeters : sChase.meters,
      gpsCoverageFractionHider: keepHider ? round.result.gpsCoverageFractionHider : hTotal.coverageFraction,
      gpsCoverageFractionSeeker: keepSeeker ? round.result.gpsCoverageFractionSeeker : sChase.coverageFraction,
      routeQualityHider: route.teams[round.hidingTeam].quality,
      routeQualitySeeker: route.teams[round.seekingTeam].quality,
    };
    const updated: RoundDoc = { ...round, result, summaryReady: true, updatedAt: d.clock.now(), version: round.version + 1 };
    tx.set(p.round(sid, rid), updated);
    tx.set(p.route(sid, rid), route);
    tx.set(p.summary(sid, rid), {
      sessionId: sid,
      roundId: rid,
      index: round.index,
      result,
      rules: round.rules,
      teamNames: round.teamNames,
      pings: round.pings,
      claims: claims.map((c) => ({
        claimId: c.claimId,
        status: c.status,
        submittedAt: c.submittedAt,
        reviewedAt: c.reviewedAt,
        rejectionReason: c.rejectionReason,
        chaseSecondsAtClaim: c.officialChaseMsAtClaim === null ? null : Math.round(c.officialChaseMsAtClaim / 1000),
        hasPhoto: !!c.photoStoredAt && !c.photoDeletedAt,
        dispute: c.dispute,
      })),
      timeline,
      routeStats: {
        hider: { total: hTotal, chase: hChase },
        seeker: { chase: sChase },
      },
      markers: route.markers,
      pauses: round.pauses,
      computedAt: d.clock.now(),
      revision,
    });
    writeViews(tx, d.db, sess, current ?? updated, members, currentClaim, d.clock.now());
  });
}
