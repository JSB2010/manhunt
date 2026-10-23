import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { roundTeams } from '../domain/crews.js';
import { buildRouteSegments, computeDistance, DEFAULT_DISTANCE_OPTIONS, ROLE_MAX_SPEED_MPS, type DistanceResult } from '../domain/geo.js';
import { isFinishedState, type CaptureClaim, type CrewRouteStats, type GpsPoint, type Role, type RouteQuality, type RoundDoc, type SessionDoc, type TeamKey } from '../domain/types.js';
import { paths, txGet, txMembers, writeViews, type Deps } from './repo.js';

/**
 * Post-round finalization (spec §5.5, §6.1): distance estimates, GPS coverage,
 * simplified route polylines, raw-track archive in GCS and the authorized
 * round summary. Runs after the finishing transition commits; idempotent and
 * retried by the watchdog when `summaryReady === false`.
 *
 * One computation per round at a time: at the end of a round the decision and
 * every phone's final upload arrive within a second or two, and each used to
 * recompute the whole recap at once (2–9 s per request, results racing). The
 * caller holding the lease reruns once more for requests that came in while it
 * worked; the others return at once.
 */

const SIMPLIFY_TOLERANCE_M = 8;
const MAX_ROUTE_POINTS_PER_TEAM = 4000;
/** A recap computation holds the lease this long; a crashed holder's lease just expires. */
export const FINALIZE_LEASE_MS = 60_000;
/** Reruns a holder makes for requests that arrived while it worked (late uploads settle within seconds). */
const MAX_FINALIZE_PASSES = 3;

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
  teams: Partial<Record<TeamKey, RouteTeam>>;
  markers: {
    roundStartAt: number | null;
    chaseStartAt: number | null;
    officialEndAt: number | null;
    claimPoint: { lat: number; lon: number; t: number } | null;
  };
  /** crews whose every phone deleted its data */
  deletedTeams: TeamKey[];
  /** phones that deleted their data ("delete my data"); their samples are never used */
  deletedUids?: string[];
}

/** Opaque per-phone storage key (no uid in object paths). */
export const phoneKey = (uid: string) => createHash('sha256').update(uid).digest('hex').slice(0, 16);

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

interface CrewTrack {
  team: TeamKey;
  role: Role;
  /** the phone the crew's route and distances come from (best GPS coverage) */
  sourceUid: string | null;
  samples: GpsPoint[];
  total: DistanceResult | null;
  chase: DistanceResult;
  phones: number;
  /** every phone of the crew deleted its data */
  deleted: boolean;
}

/**
 * A crew's route is one phone's track (the crew moves together): the phone with
 * the best GPS coverage, ties to more samples. Averaging phones would invent a
 * path nobody took when a crew splits up.
 */
function crewTrack(pre: RoundDoc, team: TeamKey, pts: GpsPoint[], deletedUids: ReadonlySet<string>, start: number, chaseStart: number, end: number): CrewTrack {
  const role: Role = team === pre.hidingTeam ? 'HIDING' : 'SEEKING';
  const snapshot = pre.operatorsByTeam[team] ?? [];
  const phones = snapshot.filter((u) => !deletedUids.has(u));
  const base = DEFAULT_DISTANCE_OPTIONS;
  const maxSpeedMps = ROLE_MAX_SPEED_MPS[role];
  let best: CrewTrack | null = null;
  for (const uid of phones) {
    const samples = pts.filter((x) => x.operatorUid === uid && x.role === role);
    const total = role === 'HIDING' ? computeDistance(samples, { ...base, from: start, to: end, maxSpeedMps }) : null;
    const chase = computeDistance(samples, { ...base, from: chaseStart, to: end, maxSpeedMps });
    const cov = (total ?? chase).coverageFraction ?? -1;
    const bestCov = best ? ((best.total ?? best.chase).coverageFraction ?? -1) : -2;
    if (!best || cov > bestCov || (cov === bestCov && samples.length > best.samples.length)) {
      best = { team, role, sourceUid: uid, samples, total, chase, phones: snapshot.length, deleted: false };
    }
  }
  if (best) return best;
  const empty = computeDistance([], { ...base, from: chaseStart, to: end, maxSpeedMps });
  return { team, role, sourceUid: null, samples: [], total: role === 'HIDING' ? empty : null, chase: empty, phones: snapshot.length, deleted: snapshot.length > 0 && phones.length === 0 };
}

export async function finalizeRound(d: Deps, sid: string, rid: string, opts: { force?: boolean } = {}) {
  const lock = paths(d.db).finalizeLock(sid, rid);
  const token = randomUUID();
  // Take the lease, or leave the holder a note to run once more and return.
  const acquired = await d.db.runTransaction(async (tx) => {
    const now = d.clock.now();
    const held = (await tx.get(lock)).data() as { token: string; until: number } | undefined;
    if (held && held.until > now) {
      tx.set(lock, { rerun: true }, { merge: true });
      return false;
    }
    tx.set(lock, { token, until: now + FINALIZE_LEASE_MS, rerun: false });
    return true;
  });
  if (!acquired) return;
  let force = !!opts.force;
  try {
    for (let pass = 0; pass < MAX_FINALIZE_PASSES; pass++) {
      await computeRecap(d, sid, rid, force);
      const again = await d.db.runTransaction(async (tx) => {
        const held = (await tx.get(lock)).data() as { token: string; rerun?: boolean } | undefined;
        if (held?.token !== token) return false;
        if (held.rerun && pass + 1 < MAX_FINALIZE_PASSES) {
          tx.set(lock, { token, until: d.clock.now() + FINALIZE_LEASE_MS, rerun: false });
          return true;
        }
        tx.delete(lock);
        return false;
      });
      if (!again) return;
      force = true;
    }
  } catch (err) {
    // Let the watchdog (summaryReady === false) recompute, including any rerun that was asked for.
    await lock.delete().catch(() => undefined);
    await paths(d.db).round(sid, rid).update({ summaryReady: false }).catch(() => undefined);
    throw err;
  }
}

async function computeRecap(d: Deps, sid: string, rid: string, force: boolean) {
  const p = paths(d.db);
  const pre = (await p.round(sid, rid).get()).data() as RoundDoc | undefined;
  if (!pre || !isFinishedState(pre.state) || !pre.result) return;
  if (pre.summaryReady === true && !force) return;

  const existingRoute = (await p.route(sid, rid).get()).data() as RouteDoc | undefined;
  const deletedUids = new Set<string>(existingRoute?.deletedUids ?? []);

  const snap = await p.points(sid, rid).get();
  const pts = snap.docs.map((x) => x.data() as GpsPoint).filter((x) => !deletedUids.has(x.operatorUid));
  const start = pre.roundStartAt ?? pre.createdAt;
  const officialEnd = pre.result.officialFoundAt ?? pre.endedAt ?? d.clock.now();
  const chaseStart = pre.chaseStartAt ?? officialEnd;
  const crews = roundTeams(pre).map((k) => crewTrack(pre, k, pts, deletedUids, start, chaseStart, officialEnd));
  const deletedTeams = crews.filter((c) => c.deleted).map((c) => c.team);

  const claimsSnap = await p.claims(sid, rid).get();
  const claims = claimsSnap.docs.map((x) => x.data() as CaptureClaim);
  const winningClaim = pre.result.claimId ? claims.find((c) => c.claimId === pre.result!.claimId) : undefined;
  let claimPoint: RouteDoc['markers']['claimPoint'] = null;
  if (winningClaim?.submittedAt && !deletedUids.has(winningClaim.seekerUid)) {
    const s = pts
      .filter((x) => x.operatorUid === winningClaim.seekerUid && x.recordedAt <= winningClaim.submittedAt! && x.horizontalAccuracyMeters <= 50)
      .sort((a, b) => b.recordedAt - a.recordedAt)[0];
    if (s && winningClaim.submittedAt - s.recordedAt <= 120_000) claimPoint = { lat: s.latitude, lon: s.longitude, t: s.recordedAt };
  }

  const revision = (existingRoute?.revision ?? 0) + 1;
  const teamRoute = (c: CrewTrack): RouteTeam =>
    c.deleted
      ? { team: c.team, role: c.role, deleted: true, quality: 'DELETED', sampleCount: 0, segments: [] }
      : {
          team: c.team,
          role: c.role,
          deleted: false,
          quality: quality(c.total ?? c.chase, c.samples.length),
          sampleCount: c.samples.length,
          segments: segmentsFor(c.samples, start, officialEnd, ROLE_MAX_SPEED_MPS[c.role]),
        };
  const route: RouteDoc = {
    sessionId: sid,
    roundId: rid,
    revision,
    computedAt: d.clock.now(),
    teams: Object.fromEntries(crews.map((c) => [c.team, teamRoute(c)])),
    markers: { roundStartAt: pre.roundStartAt, chaseStartAt: pre.chaseStartAt, officialEndAt: officialEnd, claimPoint },
    deletedTeams,
    deletedUids: [...deletedUids],
  };

  // Raw track archive (private bucket), one object per phone so a phone's data can be deleted on its own.
  const session = (await p.session(sid).get()).data() as SessionDoc | undefined;
  if (!session) return;
  // Written in parallel; the superseded revision is removed so a phone keeps one archive per round.
  const archiveKey = (uid: string, rev: number) => `sessions/${sid}/rounds/${rid}/tracks/${phoneKey(uid)}/${rev}.geojson.gz`;
  await Promise.all(
    [...new Set(pts.map((x) => x.operatorUid))].map(async (uid) => {
      const samples = pts.filter((x) => x.operatorUid === uid).sort((a, b) => a.recordedAt - b.recordedAt);
      const geo = {
        type: 'Feature',
        properties: { sessionId: sid, roundId: rid, team: samples[0]!.teamKey, revision },
        geometry: { type: 'LineString', coordinates: samples.map((s) => [s.longitude, s.latitude]) },
      };
      try {
        await d.store.put(archiveKey(uid, revision), gzipSync(Buffer.from(JSON.stringify(geo))), 'application/gzip');
        if (revision > 1) await d.store.delete(archiveKey(uid, revision - 1));
      } catch (err) {
        d.log.warn({ err }, 'track archive write failed');
      }
    }),
  );

  const eventsSnap = await p.events(sid).where('roundId', '==', rid).get();
  const timeline = eventsSnap.docs
    .map((x) => x.data() as { type: string; at: number; actorUid: string | null; details: Record<string, unknown> })
    // The recap's timeline is the round itself, not the lobby before it (ready taps, setup edits).
    .filter((e) => pre.roundStartAt === null || e.at >= pre.roundStartAt)
    .sort((a, b) => a.at - b.at)
    // Audit details may name phones (uids); the recap timeline only needs type, time and crew-level details.
    .map((e) => ({ type: e.type, at: e.at, details: Object.fromEntries(Object.entries(e.details).filter(([k]) => k !== 'uid')) }));

  await d.db.runTransaction(async (tx) => {
    const round = await txGet<RoundDoc>(tx, p.round(sid, rid));
    const sess = await txGet<SessionDoc>(tx, p.session(sid));
    if (!round || !round.result || !sess) return;
    const members = await txMembers(tx, d.db, sid);
    const current = sess.currentRoundId && sess.currentRoundId !== rid ? await txGet<RoundDoc>(tx, p.round(sid, sess.currentRoundId)) : null;
    const currentClaim = current?.activeClaimId ? await txGet<CaptureClaim>(tx, p.claim(sid, current.id, current.activeClaimId)) : null;
    const crewStats: Partial<Record<TeamKey, CrewRouteStats>> = {};
    for (const c of crews) {
      const prev = round.result.crews[c.team];
      // A crew whose every phone deleted its data keeps its earlier (location-free) totals.
      crewStats[c.team] =
        c.deleted && prev
          ? { ...prev, routeQuality: 'DELETED' }
          : {
              role: c.role,
              distanceTotalMeters: c.total?.meters ?? null,
              distanceChaseMeters: c.chase.meters,
              gpsCoverageFraction: (c.total ?? c.chase).coverageFraction,
              routeQuality: route.teams[c.team]!.quality,
              phones: c.phones,
            };
    }
    const result = { ...round.result, crews: crewStats };
    const routeSourceUids = Object.fromEntries(crews.map((c) => [c.team, c.sourceUid]));
    const updated: RoundDoc = { ...round, result, routeSourceUids, summaryReady: true, updatedAt: d.clock.now(), version: round.version + 1 };
    tx.set(p.round(sid, rid), updated);
    tx.set(p.route(sid, rid), route);
    tx.set(p.summary(sid, rid), {
      sessionId: sid,
      roundId: rid,
      index: round.index,
      result,
      rules: round.rules,
      teamNames: round.teamNames,
      claims: claims.map((c) => ({
        claimId: c.claimId,
        team: c.seekerTeam,
        status: c.status,
        submittedAt: c.submittedAt,
        reviewedAt: c.reviewedAt,
        rejectionReason: c.rejectionReason,
        chaseSecondsAtClaim: c.officialChaseMsAtClaim === null ? null : Math.round(c.officialChaseMsAtClaim / 1000),
        hasPhoto: !!c.photoStoredAt && !c.photoDeletedAt,
        dispute: c.dispute,
      })),
      timeline,
      routeStats: Object.fromEntries(crews.map((c) => [c.team, { role: c.role, total: c.total, chase: c.chase, phones: c.phones }])),
      markers: route.markers,
      pauses: round.pauses,
      computedAt: d.clock.now(),
      revision,
    });
    writeViews(tx, d.db, sess, current ?? updated, members, currentClaim, d.clock.now());
  });
}
