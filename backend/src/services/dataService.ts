import { crewOfUid, hiderUids, operatorUidsOf, roundUids, snapshotTeamOf, teamKeysOf } from '../domain/crews.js';
import { removePhoneFromRound } from '../domain/engine.js';
import { fail } from '../domain/errors.js';
import { buildScorecard, personAnalytics, type SessionResults } from '../domain/scoring.js';
import { isActiveState, isFinishedState, TEAM_KEYS, type CaptureClaim, type DomainEvent, type MemberDoc, type RoundDoc, type RoundResult, type SessionDoc, type TeamKey } from '../domain/types.js';
import { finalizeRound, phoneKey, type RouteDoc } from './finalize.js';
import { LiveActivityService } from './liveActivities.js';
import { paths, writeEvents, writeViews, type Deps } from './repo.js';
import { deletedAccountRef, SocialService, type PersonDoc, type UserDoc } from './socialService.js';

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const PHOTO_RETENTION_UNCONFIRMED_MS = 7 * 24 * 3600_000;
const PHOTO_RETENTION_CONFIRMED_MS = 30 * 24 * 3600_000;
/** Default crew colours (gameService) for crews no longer in the night. */
const CREW_COLORS: Record<TeamKey, string> = { A: '#1E88E5', B: '#F4511E', C: '#43A047' };

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

  /** Post-round artifacts of a round are for the phones that played it (its snapshot). */
  private requireRoundPhone(uid: string, r: RoundDoc) {
    if (!roundUids(r).includes(uid)) fail('NOT_FOUND', 'Round not found');
  }

  /** Route sharing needs consent from every phone that played the round — not from phones that joined later. */
  private async routeConsent(sid: string, r: RoundDoc) {
    const refs = roundUids(r).map((u) => this.p.member(sid, u));
    if (!refs.length) return false;
    const snaps = await this.d.db.getAll(...refs);
    return snaps.every((d) => (d.data() as MemberDoc | undefined)?.consent?.routeSharingAfterRound === true);
  }

  async roundSummary(uid: string, sid: string, rid: string) {
    const s = await this.memberSession(uid, sid);
    const r = await this.finishedRound(sid, rid);
    this.requireRoundPhone(uid, r);
    const sum = (await this.p.summary(sid, rid).get()).data();
    const myTeam = snapshotTeamOf(r, uid);
    // Photos: hiders (reviewers), the claiming crew, and in TOGETHER mode every seeking crew.
    const canSeePhoto = (team: TeamKey) => myTeam === r.hidingTeam || myTeam === team || (r.seekMode === 'TOGETHER' && !!myTeam && r.seekingTeams.includes(myTeam));
    return {
      roundId: rid,
      index: r.index,
      state: r.state,
      summaryReady: r.summaryReady === true,
      hidingTeam: r.hidingTeam,
      seekingTeams: r.seekingTeams,
      seekMode: r.seekMode,
      myTeam,
      teamNames: r.teamNames,
      teamColors: Object.fromEntries(TEAM_KEYS.filter((k) => r.teamNames[k]).map((k) => [k, s.teams[k]?.color ?? null])),
      rules: r.rules,
      result: r.result,
      roundStartAt: iso(r.roundStartAt),
      chaseStartAt: iso(r.chaseStartAt),
      endedAt: iso(r.endedAt),
      // Released pins only, without server-only source fields.
      pings: r.pings.map((p) => ({
        index: p.index,
        status: p.status,
        delayed: p.delayed,
        scheduledAt: iso(p.scheduledAt),
        releasedAt: iso(p.releasedAt),
        observedAt: iso(p.observedAt),
        latitude: p.latitude,
        longitude: p.longitude,
        accuracyMeters: p.accuracyMeters,
        ageSeconds: p.ageSeconds,
      })),
      claims: ((sum?.claims ?? []) as { claimId: string; team: TeamKey; status: string; submittedAt: number | null; reviewedAt: number | null; rejectionReason: string | null; chaseSecondsAtClaim: number | null; hasPhoto: boolean }[]).map((c) => ({
        claimId: c.claimId,
        team: c.team,
        status: c.status,
        rejectionReason: c.rejectionReason,
        chaseSecondsAtClaim: c.chaseSecondsAtClaim,
        submittedAt: iso(c.submittedAt),
        reviewedAt: iso(c.reviewedAt),
        photoPath: c.hasPhoto && canSeePhoto(c.team) ? `/v1/sessions/${sid}/rounds/${rid}/captures/${c.claimId}/photo` : null,
      })),
      timeline: ((sum?.timeline ?? []) as { type: string; at: number; details: Record<string, unknown> }[]).map((e) => ({ ...e, at: iso(e.at) })),
      pauses: r.pauses.map((p) => ({ kind: p.kind, startAt: iso(p.startAt), endAt: iso(p.endAt), reason: p.reason, phase: p.phase })),
      routeStats: sum?.routeStats ?? null,
      routesAvailable: await this.routeConsent(sid, r),
    };
  }

  async routes(uid: string, sid: string, rid: string, format: 'json' | 'geojson') {
    await this.memberSession(uid, sid);
    const r = await this.finishedRound(sid, rid);
    this.requireRoundPhone(uid, r);
    if (!(await this.routeConsent(sid, r))) fail('CONSENT_REQUIRED', 'Every phone in the round must have agreed to post-round route sharing');
    const route = (await this.p.route(sid, rid).get()).data() as RouteDoc | undefined;
    if (!route) fail('RETRYABLE_TEMPORARY', 'Route recap is still being computed');
    const keys = TEAM_KEYS.filter((k) => route!.teams[k]);
    if (format === 'geojson') {
      return {
        type: 'FeatureCollection',
        features: keys.flatMap((k) =>
          route!.teams[k]!.segments.map((seg, i) => ({
            type: 'Feature',
            properties: { team: k, role: route!.teams[k]!.role, segment: i, quality: route!.teams[k]!.quality },
            geometry: { type: 'LineString', coordinates: seg.points.map((p) => [p.lon, p.lat]) },
          })),
        ),
      };
    }
    return {
      roundId: rid,
      revision: route!.revision,
      teams: Object.fromEntries(
        keys.map((k) => {
          const t = route!.teams[k]!;
          return [
            k,
            {
              team: t.team,
              role: t.role,
              deleted: t.deleted,
              quality: t.quality,
              sampleCount: t.sampleCount,
              segments: t.segments.map((seg) => ({ points: seg.points.map((p) => ({ latitude: p.lat, longitude: p.lon, t: iso(p.t) })) })),
            },
          ];
        }),
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
    const { results } = await this.sessionResults(sid);
    const sc = buildScorecard(s, results);
    return {
      sessionId: sid,
      title: s.title,
      scheduledDate: s.scheduledDate,
      status: s.status,
      playedRounds: results.length,
      teams: {
        // A crew removed later in the night is listed as it last played.
        ...Object.fromEntries(
          [...results]
            .sort((a, b) => a.roundIndex - b.roundIndex)
            .flatMap((r) => TEAM_KEYS.filter((k) => r.teamNames[k] && !s.teams[k]).map((k) => [k, { name: r.teamNames[k]!, color: CREW_COLORS[k], roster: r.rosterSnapshot[k] ?? [] }] as const)),
        ),
        ...Object.fromEntries(teamKeysOf(s).map((k) => [k, { name: s.teams[k]!.name, color: s.teams[k]!.color, roster: s.teams[k]!.roster }])),
      },
      scorecard: sc,
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
        operatorUidsByRound: Object.fromEntries(rounds.map((r) => [r.id, roundUids(r)])),
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
            session: { id: s.id, title: s.title, scheduledDate: s.scheduledDate, teams: Object.fromEntries(teamKeysOf(s).map((k) => [k, { name: s.teams[k]!.name, roster: s.teams[k]!.roster }])), rules: s.rules },
            scorecard: sc,
            exportedAt: new Date(this.d.clock.now()).toISOString(),
          },
          null,
          2,
        ),
      };
    }
    const header = [
      'session_title', 'date', 'round', 'hiding_crew', 'seeking_crews', 'seek_mode', 'catch_credit', 'hiding_roster', 'seeking_rosters', 'outcome',
      'head_start_s', 'chase_s', 'right_censored', 'pause_s', 'ping_slots', 'pings_released', 'pings_missing', 'hider_foot_total_m', 'hider_foot_chase_m',
      'seeker_vehicle_chase_m', 'hider_gps_coverage', 'seeker_gps_coverage', 'rules_fingerprint',
    ];
    const q = (v: unknown) => {
      const str = v === null || v === undefined ? '' : String(v);
      // CSV-injection safe: neutralize leading formula characters.
      const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const crewName = (r: RoundResult, k: TeamKey) => r.teamNames[k] ?? `Crew ${k}`;
    const roster = (r: RoundResult, k: TeamKey) => (r.rosterSnapshot[k] ?? []).map((p) => p.displayName).join('; ');
    // Several seeking crews: one "crew: value" entry per crew, attributed to crews, never people.
    const perSeeker = (r: RoundResult, f: (k: TeamKey) => unknown) => r.seekingTeams.map((k) => `${crewName(r, k)}: ${f(k) ?? ''}`).join(' | ');
    const rows = results.map((r) => {
      const h = r.crews[r.hidingTeam];
      return [
        s.title, s.scheduledDate, r.roundIndex, crewName(r, r.hidingTeam), r.seekingTeams.map((k) => crewName(r, k)).join(' | '), r.seekMode,
        r.catchCreditTeams.map((k) => crewName(r, k)).join(' | '), roster(r, r.hidingTeam), perSeeker(r, (k) => roster(r, k)),
        r.outcome, r.headStartSeconds, r.observedChaseSeconds, r.isRightCensored, r.totalPauseSeconds, r.pingSlots, r.pingsReleased, r.pingsMissing,
        h?.distanceTotalMeters, h?.distanceChaseMeters, perSeeker(r, (k) => r.crews[k]?.distanceChaseMeters), h?.gpsCoverageFraction,
        perSeeker(r, (k) => r.crews[k]?.gpsCoverageFraction), r.rulesFingerprint,
      ].map(q).join(',');
    });
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

  /**
   * A phone deletes its own tracks and photos from shared history. Each crew's
   * route is then recomputed from its other phones (or marked deleted), and only
   * the pins released from this phone's fixes are redacted.
   */
  async deleteMyData(uid: string, sid: string) {
    const s = (await this.p.session(sid).get()).data() as SessionDoc | undefined;
    if (!s || !s.memberUids.includes(uid)) fail('NOT_FOUND', 'Session not found');
    const rounds = (await this.p.rounds(sid).get()).docs.map((d) => d.data() as RoundDoc);
    if (rounds.some((r) => isActiveState(r.state) && roundUids(r).includes(uid))) fail('STALE_PHASE', 'Abort or finish the active round first');
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
      if (!roundUids(r).includes(uid) || !isFinishedState(r.state)) continue;
      await this.d.store.deletePrefix(`sessions/${sid}/rounds/${r.id}/tracks/${phoneKey(uid)}/`);
      const routeRef = this.p.route(sid, r.id);
      const route = (await routeRef.get()).data() as RouteDoc | undefined;
      await routeRef.set({ sessionId: sid, roundId: r.id, deletedUids: [...new Set([...(route?.deletedUids ?? []), uid])] }, { merge: true });
      const claims = await this.p.claims(sid, r.id).where('seekerUid', '==', uid).get();
      for (const c of claims.docs) {
        const claim = c.data() as CaptureClaim;
        if (claim.photoDeletedAt) continue;
        await this.d.store.delete(claim.imageObjectKey);
        await c.ref.update({ photoDeletedAt: now });
        photos++;
      }
      // Released pins are hider positions: redact the ones that came from this phone's fixes
      // (timestamps/status stay so the round's ping counts remain intact).
      const lone = hiderUids(r).length === 1 && hiderUids(r)[0] === uid;
      // Pins from before crews have no sourceUid at all; like null, that means the lone hider phone.
      const fromMe = (p: RoundDoc['pings'][number]) => p.latitude !== null && (p.sourceUid === uid || ((p.sourceUid ?? null) === null && lone));
      if (r.pings.some(fromMe)) {
        const redacted = r.pings.map((p) => (fromMe(p) ? { ...p, latitude: null, longitude: null, sourcePointId: null } : p));
        await this.p.round(sid, r.id).update({ pings: redacted, updatedAt: now, version: r.version + 1 });
        const pingDocs = await this.p.round(sid, r.id).collection('pings').get();
        await Promise.all(
          pingDocs.docs.filter((d) => fromMe(d.data() as RoundDoc['pings'][number])).map((d) => d.ref.update({ latitude: null, longitude: null, sourcePointId: null })),
        );
      }
      // Recompute crew routes and distances without this phone (also re-renders views).
      await finalizeRound(this.d, sid, r.id, { force: true }).catch((err) => this.d.log.warn({ err, roundId: r.id }, 're-finalize after data deletion failed'));
    }
    // Re-render views so redacted pins disappear from every phone's read model.
    await this.d.db.runTransaction(async (tx) => {
      const sess = (await tx.get(this.p.session(sid))).data() as SessionDoc;
      const membersSnap = await tx.get(this.p.members(sid));
      const members: Record<string, MemberDoc> = {};
      membersSnap.docs.forEach((m) => (members[m.id] = m.data() as MemberDoc));
      const current = sess.currentRoundId ? ((await tx.get(this.p.round(sid, sess.currentRoundId))).data() as RoundDoc) : null;
      writeViews(tx, this.d.db, sess, current, members, null, now);
    });
    await new LiveActivityService(this.d).forget(uid, sid);
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
      const others = operatorUidsOf(s).filter((u) => u !== uid);
      if (s.hostUid === uid && !others.length) {
        await this.deleteSessionUnchecked(s.id);
        sessionsDeleted++;
        continue;
      }
      // Leave any round in progress: the round goes on with the crew's other phones (or aborts if none are left).
      const rounds = (await this.p.rounds(s.id).get()).docs.map((x) => x.data() as RoundDoc);
      for (const r of rounds.filter((x) => isActiveState(x.state) && roundUids(x).includes(uid))) {
        await this.d.db.runTransaction(async (tx) => {
          const cur = (await tx.get(this.p.round(s.id, r.id))).data() as RoundDoc | undefined;
          if (!cur || !isActiveState(cur.state)) return;
          const t = removePhoneFromRound(cur, uid, 'Operator account deleted', now);
          tx.set(this.p.round(s.id, r.id), { ...t.round, ...(isFinishedState(t.round.state) ? { summaryReady: false } : {}) });
          writeEvents(tx, this.d.db, s.id, t.events);
        });
      }
      await this.deleteMyData(uid, s.id).catch((err) => this.d.log.warn({ err }, 'deleteMyData during account deletion failed'));
      // Keep everyone else's history; take this phone off its crew, hand the organizer role on, deactivate membership.
      await this.d.db.runTransaction(async (tx) => {
        const sess = (await tx.get(this.p.session(s.id))).data() as SessionDoc;
        const membersSnap = await tx.get(this.p.members(s.id));
        const members: Record<string, MemberDoc> = {};
        membersSnap.docs.forEach((m) => (members[m.id] = m.data() as MemberDoc));
        const current = sess.currentRoundId ? ((await tx.get(this.p.round(s.id, sess.currentRoundId))).data() as RoundDoc) : null;
        const team = crewOfUid(sess, uid);
        if (team) sess.teams[team]!.operatorUids = sess.teams[team]!.operatorUids.filter((u) => u !== uid);
        const edited: string[] = [];
        if (sess.hostUid === uid) {
          const next = operatorUidsOf(sess).find((u) => members[u]?.active) ?? others[0]!;
          sess.hostUid = next;
          if (members[next]) members[next] = { ...members[next]!, isHost: true };
          if (members[next]) edited.push(next);
        }
        sess.version++;
        sess.updatedAt = now;
        if (members[uid]) members[uid] = { ...members[uid]!, active: false, isHost: false, displayName: 'Deleted account', selfPersonId: null };
        if (members[uid]) edited.push(uid);
        tx.set(this.p.session(s.id), sess);
        writeViews(tx, this.d.db, sess, current, members, null, now, { except: edited });
        for (const u of edited) tx.set(this.p.member(s.id, u), members[u]!);
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
    await del(this.p.invites().where('createdByUid', '==', uid).where('kind', '==', 'DIRECT'));
    await del(this.p.invites().where('targetUid', '==', uid));
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
    await Promise.all(members.docs.map((d) => d.ref.update({ active: false, viewHash: null })));
    await this.p.session(sid).update({ revokedAt: now, version: s.version + 1 });
    // Take the round off every Lock Screen now, and drop the activity tokens.
    const current = s.currentRoundId ? ((await this.p.round(sid, s.currentRoundId).get()).data() as RoundDoc | undefined) : undefined;
    await new LiveActivityService(this.d).endAll(sid, current ?? null).catch((err) => this.d.log.warn({ err }, 'ending live activities on revoke failed'));
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
          keepCache.set(c.sessionId, !!s && teamKeysOf(s).every((k) => s.keepPhotos[k] === true));
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
