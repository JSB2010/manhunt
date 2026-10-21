import { fail } from '../domain/errors.js';
import { buildScorecard, personAnalytics, type SessionResults } from '../domain/scoring.js';
import { isFinishedState, type CaptureClaim, type DomainEvent, type MemberDoc, type RoundDoc, type RoundResult, type SessionDoc, type TeamKey } from '../domain/types.js';
import { teamForUid } from '../domain/engine.js';
import type { RouteDoc } from './finalize.js';
import { paths, writeEvents, writeViews, type Deps } from './repo.js';
import { deletedAccountRef, SocialService, type PersonDoc, type UserDoc } from './socialService.js';

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const PHOTO_RETENTION_UNCONFIRMED_MS = 7 * 24 * 3600_000;
const PHOTO_RETENTION_CONFIRMED_MS = 30 * 24 * 3600_000;

/**
 * Post-round data access, analytics, exports, deletion and retention.
 * Every read path re-checks membership and round completion server-side.
 */
export class DataService {
  private p;
  constructor(private d: Deps) {
    this.p = paths(d.db);
  }

  private async memberSession(uid: string, sid: string) {
    const s = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!s || !s.memberUids.includes(uid) || s.revokedAt) fail('NOT_FOUND', 'Session not found');
    const m = (await this.p.member(sid, uid).get()).data() as MemberDoc | undefined;
    if (!m?.active) fail('NOT_FOUND', 'Session not found');
    return s!;
  }

  private async finishedRound(sid: string, rid: string) {
    const r = (await this.p.round(sid, rid).get()).data() as RoundDoc | undefined;
    if (!r) fail('NOT_FOUND', 'Round not found');
    // Post-round data is never available while the round is active (spec §1 invariant).
    if (!isFinishedState(r!.state)) fail('GAME_NOT_READY', 'Round summary is available after the round ends');
    return r!;
  }

  async roundSummary(uid: string, sid: string, rid: string) {
    const s = await this.memberSession(uid, sid);
    const r = await this.finishedRound(sid, rid);
    const sum = (await this.p.summary(sid, rid).get()).data();
    const members = await this.p.members(sid).get();
    const routeConsent = members.docs.every((d) => (d.data() as MemberDoc).consent?.routeSharingAfterRound === true);
    return {
      roundId: rid,
      index: r.index,
      state: r.state,
      summaryReady: r.summaryReady === true,
      hidingTeam: r.hidingTeam,
      seekingTeam: r.seekingTeam,
      teamNames: r.teamNames,
      teamColors: { A: s.teams.A.color, B: s.teams.B.color },
      rules: r.rules,
      result: r.result,
      roundStartAt: iso(r.roundStartAt),
      chaseStartAt: iso(r.chaseStartAt),
      endedAt: iso(r.endedAt),
      pings: r.pings.map((p) => ({ ...p, scheduledAt: iso(p.scheduledAt), releasedAt: iso(p.releasedAt), observedAt: iso(p.observedAt) })),
      claims: ((sum?.claims ?? []) as { claimId: string; status: string; submittedAt: number | null; reviewedAt: number | null; rejectionReason: string | null; chaseSecondsAtClaim: number | null; hasPhoto: boolean }[]).map((c) => ({
        ...c,
        submittedAt: iso(c.submittedAt),
        reviewedAt: iso(c.reviewedAt),
        photoPath: c.hasPhoto ? `/v1/sessions/${sid}/rounds/${rid}/captures/${c.claimId}/photo` : null,
      })),
      timeline: ((sum?.timeline ?? []) as { type: string; at: number; details: Record<string, unknown> }[]).map((e) => ({ ...e, at: iso(e.at) })),
      pauses: r.pauses.map((p) => ({ kind: p.kind, startAt: iso(p.startAt), endAt: iso(p.endAt), reason: p.reason, phase: p.phase })),
      routeStats: sum?.routeStats ?? null,
      routesAvailable: routeConsent,
      roleOverride: r.roleOverride,
    };
  }

  async routes(uid: string, sid: string, rid: string, format: 'json' | 'geojson') {
    await this.memberSession(uid, sid);
    await this.finishedRound(sid, rid);
    const members = await this.p.members(sid).get();
    if (!members.docs.every((d) => (d.data() as MemberDoc).consent?.routeSharingAfterRound === true)) {
      fail('CONSENT_REQUIRED', 'Both operators must have agreed to post-round route sharing');
    }
    const route = (await this.p.route(sid, rid).get()).data() as RouteDoc | undefined;
    if (!route) fail('RETRYABLE_TEMPORARY', 'Route recap is still being computed');
    if (format === 'geojson') {
      return {
        type: 'FeatureCollection',
        features: (['A', 'B'] as const).flatMap((k) =>
          route!.teams[k].segments.map((seg, i) => ({
            type: 'Feature',
            properties: { team: k, role: route!.teams[k].role, segment: i, quality: route!.teams[k].quality },
            geometry: { type: 'LineString', coordinates: seg.points.map((p) => [p.lon, p.lat]) },
          })),
        ),
      };
    }
    return {
      roundId: rid,
      revision: route!.revision,
      teams: Object.fromEntries(
        (['A', 'B'] as const).map((k) => [
          k,
          {
            ...route!.teams[k],
            segments: route!.teams[k].segments.map((s) => ({ points: s.points.map((p) => ({ latitude: p.lat, longitude: p.lon, t: iso(p.t) })) })),
          },
        ]),
      ),
      markers: {
        roundStartAt: iso(route!.markers.roundStartAt),
        chaseStartAt: iso(route!.markers.chaseStartAt),
        officialEndAt: iso(route!.markers.officialEndAt),
        claimPoint: route!.markers.claimPoint ? { latitude: route!.markers.claimPoint.lat, longitude: route!.markers.claimPoint.lon, t: iso(route!.markers.claimPoint.t) } : null,
      },
    };
  }

  private async sessionResults(sid: string): Promise<{ rounds: RoundDoc[]; results: RoundResult[] }> {
    const snap = await this.p.rounds(sid).get();
    const rounds = snap.docs.map((x) => x.data() as RoundDoc).sort((a, b) => a.index - b.index);
    return { rounds, results: rounds.filter((r) => isFinishedState(r.state) && r.result).map((r) => r.result!) };
  }

  async sessionAnalytics(uid: string, sid: string) {
    const s = await this.memberSession(uid, sid);
    const { rounds, results } = await this.sessionResults(sid);
    const sc = buildScorecard(s, results);
    return {
      sessionId: sid,
      title: s.title,
      scheduledDate: s.scheduledDate,
      status: s.status,
      plannedRounds: s.rules.totalRounds,
      playedRounds: results.length,
      teams: {
        A: { name: s.teams.A.name, color: s.teams.A.color, roster: s.teams.A.roster },
        B: { name: s.teams.B.name, color: s.teams.B.color, roster: s.teams.B.roster },
      },
      scorecard: sc,
      roleOverrides: rounds.filter((r) => r.roleOverride).map((r) => ({ roundIndex: r.index, ...r.roleOverride, at: iso(r.roleOverride!.at) })),
      notDirectlyComparable: !sc.rulesConsistent,
    };
  }

  async personStats(uid: string, personId: string) {
    const social = new SocialService(this.d);
    const person = await social.canSeePerson(uid, personId);
    if (!person) fail('NOT_FOUND', 'Person not found');
    const { canonical, all } = await social.resolvePersonIds(personId);
    const canonicalDoc = (await this.p.person(canonical).get()).data() as PersonDoc;
    // Only sessions the requester participated in contribute (authorization by construction).
    const sessions = await this.p.sessions().where('memberUids', 'array-contains', uid).limit(300).get();
    const relevant = sessions.docs.map((x) => x.data() as SessionDoc).filter((s) => !s.revokedAt && s.participantPersonIds.some((id) => all.has(id)));
    const data: SessionResults[] = [];
    for (const s of relevant) {
      const { rounds, results } = await this.sessionResults(s.id);
      data.push({
        session: s,
        results,
        operatorUidsByRound: Object.fromEntries(rounds.map((r) => [r.id, { hider: r.hiderUid, seeker: r.seekerUid }])),
      });
    }
    return {
      person: social.personOut(canonicalDoc, uid),
      analytics: personAnalytics(all, canonicalDoc.linkedUid, data),
    };
  }

  async exportSession(uid: string, sid: string, format: 'csv' | 'json') {
    const s = await this.memberSession(uid, sid);
    const { results } = await this.sessionResults(sid);
    const sc = buildScorecard(s, results);
    if (format === 'json') {
      // Redacted: no GPS coordinates, no photo keys.
      return {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            session: { id: s.id, title: s.title, scheduledDate: s.scheduledDate, teams: { A: { name: s.teams.A.name, roster: s.teams.A.roster }, B: { name: s.teams.B.name, roster: s.teams.B.roster } }, rules: s.rules },
            scorecard: sc,
            exportedAt: new Date(this.d.clock.now()).toISOString(),
          },
          null,
          2,
        ),
      };
    }
    const header = [
      'session_title', 'date', 'round', 'hiding_crew', 'seeking_crew', 'hiding_roster', 'seeking_roster', 'outcome', 'head_start_s',
      'chase_s', 'right_censored', 'pause_s', 'ping_slots', 'pings_released', 'pings_missing', 'hider_foot_total_m', 'hider_foot_chase_m',
      'seeker_vehicle_chase_m', 'hider_gps_coverage', 'seeker_gps_coverage', 'rules_fingerprint',
    ];
    const q = (v: unknown) => {
      const str = v === null || v === undefined ? '' : String(v);
      // CSV-injection safe: neutralize leading formula characters.
      const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const rows = results.map((r) =>
      [
        s.title, s.scheduledDate, r.roundIndex, r.hidingTeamName, r.seekingTeamName,
        r.hidingRosterSnapshot.map((p) => p.displayName).join('; '), r.seekingRosterSnapshot.map((p) => p.displayName).join('; '),
        r.outcome, r.headStartSeconds, r.observedChaseSeconds, r.isRightCensored, r.totalPauseSeconds, r.pingSlots, r.pingsReleased, r.pingsMissing,
        r.hidingDistanceTotalMeters, r.hidingDistanceChaseMeters, r.seekingDistanceChaseMeters, r.gpsCoverageFractionHider, r.gpsCoverageFractionSeeker, r.rulesFingerprint,
      ].map(q).join(','),
    );
    return { contentType: 'text/csv', body: [header.join(','), ...rows].join('\n') + '\n' };
  }

  // -------------------------------------------------------------------------
  // Deletion (spec §11.7–8)
  // -------------------------------------------------------------------------

  /** Organizer deletes the whole night: Firestore subtree, invites and every GCS object. */
  async deleteSession(uid: string, sid: string) {
    const s = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!s || !s.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    if (s!.hostUid !== uid) fail('OPERATOR_NOT_AUTHORIZED', 'Only the organizer can delete the whole night; use "delete my data" instead');
    const rounds = await this.p.rounds(sid).get();
    if (rounds.docs.some((r) => ['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'].includes(r.get('state')))) fail('STALE_PHASE', 'Abort the active round first');
    const objects = await this.d.store.deletePrefix(`sessions/${sid}/`);
    const invites = await this.p.invites().where('sessionId', '==', sid).get();
    await Promise.all(invites.docs.map((d) => d.ref.delete()));
    await this.d.db.recursiveDelete(this.p.session(sid));
    this.d.log.info({ sessionId: sid, objects }, 'session deleted');
    return { deleted: true, objectsDeleted: objects };
  }

  /** Either operator deletes their own operator tracks and photos from shared history. */
  async deleteMyData(uid: string, sid: string) {
    const s = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!s || !s.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    const team = teamForUid(s!, uid);
    const rounds = (await this.p.rounds(sid).get()).docs.map((d) => d.data() as RoundDoc);
    if (rounds.some((r) => ['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'].includes(r.state))) fail('STALE_PHASE', 'Abort or finish the active round first');
    let points = 0;
    let photos = 0;
    const now = this.d.clock.now();
    for (const r of rounds) {
      const mine = await this.p.points(sid, r.id).where('operatorUid', '==', uid).get();
      for (let i = 0; i < mine.docs.length; i += 400) {
        const batch = this.d.db.batch();
        mine.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      points += mine.size;
      const myTeam = r.hiderUid === uid ? r.hidingTeam : r.seekerUid === uid ? r.seekingTeam : team;
      if (myTeam) {
        const teamId = s!.teams[myTeam].teamId;
        await this.d.store.deletePrefix(`sessions/${sid}/rounds/${r.id}/tracks/${teamId}/`);
        const routeRef = this.p.route(sid, r.id);
        const route = (await routeRef.get()).data() as RouteDoc | undefined;
        if (route) {
          route.teams[myTeam] = { ...route.teams[myTeam], deleted: true, quality: 'DELETED', sampleCount: 0, segments: [] };
          route.deletedTeams = [...new Set([...route.deletedTeams, myTeam])];
          if (route.markers.claimPoint && r.seekerUid === uid) route.markers.claimPoint = null;
          await routeRef.set(route);
        } else if (isFinishedState(r.state)) {
          await routeRef.set({ sessionId: sid, roundId: r.id, revision: 0, computedAt: now, teams: {}, markers: {}, deletedTeams: [myTeam] }, { merge: true });
        }
      }
      const claims = await this.p.claims(sid, r.id).where('seekerUid', '==', uid).get();
      for (const c of claims.docs) {
        const claim = c.data() as CaptureClaim;
        if (claim.photoDeletedAt) continue;
        await this.d.store.delete(claim.imageObjectKey);
        await c.ref.update({ photoDeletedAt: now });
        photos++;
      }
      // Released pins are positions of the hiding operator: redact their coordinates too
      // (timestamps/status stay so the round's ping counts remain intact).
      if (r.hiderUid === uid && r.pings.some((p) => p.latitude !== null)) {
        const redacted = r.pings.map((p) => ({ ...p, latitude: null, longitude: null, sourcePointId: null }));
        await this.p.round(sid, r.id).update({ pings: redacted, updatedAt: now, version: r.version + 1 });
        const pingDocs = await this.p.round(sid, r.id).collection('pings').get();
        await Promise.all(pingDocs.docs.map((d) => d.ref.update({ latitude: null, longitude: null, sourcePointId: null })));
        await this.p.summary(sid, r.id).set({ pings: redacted }, { merge: true });
      }
      await this.p.summary(sid, r.id).set({ routeDeletedTeams: myTeam ? [myTeam] : [] }, { merge: true });
    }
    // Re-render views so redacted pins disappear from both operators' read models.
    await this.d.db.runTransaction(async (tx) => {
      const sess = (await tx.get(this.p.session(sid))).data() as SessionDoc;
      const membersSnap = await tx.get(this.p.members(sid));
      const members: Record<string, MemberDoc> = {};
      membersSnap.docs.forEach((m) => (members[m.id] = m.data() as MemberDoc));
      const current = sess.currentRoundId ? ((await tx.get(this.p.round(sid, sess.currentRoundId))).data() as RoundDoc) : null;
      writeViews(tx, this.d.db, sess, current, members, null, now);
    });
    const ev: DomainEvent = { type: 'ROUTE_DELETED', at: now, actorUid: uid, roundId: null, details: { pointsDeleted: points, photosDeleted: photos } };
    await this.d.db.runTransaction(async (tx) => {
      writeEvents(tx, this.d.db, sid, [ev]);
    });
    return { pointsDeleted: points, photosDeleted: photos };
  }

  /** Account deletion: own tracks/photos everywhere, social graph, profile, then the auth user. */
  async deleteAccount(uid: string) {
    const now = this.d.clock.now();
    await this.p.user(uid).set({ deletion: { requestedAt: now, status: 'IN_PROGRESS' } }, { merge: true });
    await deletedAccountRef(this.d.db, uid).set({ uid, deletedAt: now });
    const sessions = await this.p.sessions().where('memberUids', 'array-contains', uid).get();
    let sessionsDeleted = 0;
    for (const d of sessions.docs) {
      const s = d.data() as SessionDoc;
      const otherOperator = (['A', 'B'] as TeamKey[]).map((k) => s.teams[k].operatorUid).find((u) => u && u !== uid);
      const rounds = (await this.p.rounds(s.id).get()).docs.map((x) => x.data() as RoundDoc);
      for (const r of rounds.filter((x) => ['HEAD_START', 'CHASE', 'CAPTURE_PENDING', 'PAUSED'].includes(x.state))) {
        await this.p.round(s.id, r.id).update({ state: 'ABORTED', active: false, abortedReason: 'Operator account deleted', endedAt: now, summaryReady: false });
      }
      if (s.hostUid === uid && !otherOperator) {
        await this.deleteSessionUnchecked(s.id);
        sessionsDeleted++;
        continue;
      }
      await this.deleteMyData(uid, s.id).catch((err) => this.d.log.warn({ err }, 'deleteMyData during account deletion failed'));
      // Keep the other operator's history; anonymize this account's operator label and deactivate membership.
      await this.d.db.runTransaction(async (tx) => {
        const sessSnap = await tx.get(this.p.session(s.id));
        const sess = sessSnap.data() as SessionDoc;
        const membersSnap = await tx.get(this.p.members(s.id));
        const members: Record<string, MemberDoc> = {};
        membersSnap.docs.forEach((m) => (members[m.id] = m.data() as MemberDoc));
        for (const k of ['A', 'B'] as TeamKey[]) {
          if (sess.teams[k].operatorUid === uid) sess.teams[k].operatorDisplayName = 'Deleted account';
        }
        if (members[uid]) members[uid] = { ...members[uid]!, active: false, displayName: 'Deleted account' };
        tx.set(this.p.session(s.id), sess);
        if (members[uid]) tx.set(this.p.member(s.id, uid), members[uid]!);
        const current = sess.currentRoundId ? ((await tx.get(this.p.round(s.id, sess.currentRoundId))).data() as RoundDoc) : null;
        writeViews(tx, this.d.db, sess, current, members, null, now);
      });
    }
    // Social graph and profile.
    const del = async (q: FirebaseFirestore.Query) => {
      const snap = await q.get();
      await Promise.all(snap.docs.map((x) => x.ref.delete()));
    };
    await del(this.p.friendships().where('uids', 'array-contains', uid));
    await del(this.p.friendRequests().where('fromUid', '==', uid));
    await del(this.p.friendRequests().where('toUid', '==', uid));
    await del(this.p.groups().where('ownerUid', '==', uid));
    await del(this.p.linkRequests().where('requesterUid', '==', uid));
    await del(this.p.invites().where('createdByUid', '==', uid));
    const linked = await this.p.people().where('linkedUid', '==', uid).get();
    // The person record stays (other nights reference it) but the account link is removed.
    await Promise.all(linked.docs.map((x) => x.ref.update({ linkedUid: null, isSelf: false })));
    const u = (await this.p.user(uid).get()).data() as UserDoc | undefined;
    if (u?.handle) await this.p.handle(u.handle).delete();
    if (u?.friendInviteToken) await this.p.friendTokens(u.friendInviteToken).delete();
    await this.d.db.recursiveDelete(this.p.user(uid));
    if (this.d.deleteAuthUser) await this.d.deleteAuthUser(uid);
    return { status: 'COMPLETED', sessionsDeleted, sessionsAnonymized: sessions.size - sessionsDeleted };
  }

  private async deleteSessionUnchecked(sid: string) {
    await this.d.store.deletePrefix(`sessions/${sid}/`);
    const invites = await this.p.invites().where('sessionId', '==', sid).get();
    await Promise.all(invites.docs.map((d) => d.ref.delete()));
    await this.d.db.recursiveDelete(this.p.session(sid));
  }

  /** Revoke a session (security incident): deny all access, invalidate invites, keep minimal audit. */
  async revokeSession(uid: string, sid: string) {
    const s = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!s || s.hostUid !== uid) fail('NOT_FOUND', 'Session not found');
    const now = this.d.clock.now();
    const invites = await this.p.invites().where('sessionId', '==', sid).get();
    await Promise.all(invites.docs.map((d) => d.ref.update({ revoked: true })));
    const views = await this.p.session(sid).collection('views').get();
    await Promise.all(views.docs.map((d) => d.ref.delete()));
    const members = await this.p.members(sid).get();
    await Promise.all(members.docs.map((d) => d.ref.update({ active: false })));
    await this.p.session(sid).update({ revokedAt: now, version: s.version + 1 });
    await this.d.db.runTransaction(async (tx) =>
      writeEvents(tx, this.d.db, sid, [{ type: 'SESSION_REVOKED', at: now, actorUid: uid, roundId: null, details: {} }]),
    );
    return { revoked: true };
  }

  // -------------------------------------------------------------------------
  // Retention sweep (worker, daily)
  // -------------------------------------------------------------------------

  async retentionSweep() {
    const now = this.d.clock.now();
    const report = { pointsDeleted: 0, photosDeleted: 0, idempotencyDeleted: 0, invitesDeleted: 0 };
    // Raw GPS: Firestore TTL policy on `expireAt` is primary; this is the backstop.
    const oldPoints = await this.d.db.collectionGroup('points').where('expireAt', '<', new Date(now)).limit(2000).get();
    for (let i = 0; i < oldPoints.docs.length; i += 400) {
      const batch = this.d.db.batch();
      oldPoints.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    report.pointsDeleted = oldPoints.size;

    const claims = await this.d.db.collectionGroup('captures').where('photoDeletedAt', '==', null).limit(1000).get();
    const keepCache = new Map<string, boolean>();
    for (const doc of claims.docs) {
      const c = doc.data() as CaptureClaim;
      let expired = false;
      if (c.status === 'CONFIRMED') {
        if (!keepCache.has(c.sessionId)) {
          const s = (await this.p.session(c.sessionId).get()).data() as SessionDoc | undefined;
          keepCache.set(c.sessionId, !!s && s.keepPhotos.A && s.keepPhotos.B);
        }
        expired = !keepCache.get(c.sessionId) && now - (c.submittedAt ?? c.createdAt) > PHOTO_RETENTION_CONFIRMED_MS;
      } else if (c.status !== 'PENDING') {
        expired = now - c.createdAt > PHOTO_RETENTION_UNCONFIRMED_MS;
      }
      if (expired) {
        await this.d.store.delete(c.imageObjectKey);
        await doc.ref.update({ photoDeletedAt: now });
        report.photosDeleted++;
      }
    }
    const idem = await this.p.idempotency('x').parent.where('expireAt', '<', new Date(now)).limit(1000).get();
    await Promise.all(idem.docs.map((d) => d.ref.delete()));
    report.idempotencyDeleted = idem.size;
    const inv = await this.p.invites().where('expiresAt', '<', now - 24 * 3600_000).limit(500).get();
    await Promise.all(inv.docs.map((d) => d.ref.delete()));
    report.invitesDeleted = inv.size;
    this.d.log.info({ retention: report }, 'retention sweep');
    return report;
  }
}
