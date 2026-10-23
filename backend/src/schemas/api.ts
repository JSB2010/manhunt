import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { RulesPatchSchema } from '../domain/rules.js';

/** Parse untrusted input; unknown keys are rejected so role/team can never be smuggled in. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid request', {
      issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(60);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const RosterEntry = z.object({ personId: id.optional(), displayName: name }).strict();

/** A crew's people. `name` and `color` are accepted from older apps and ignored: crews are named after their people (ADR 0019). */
export const TeamInput = z
  .object({
    name: name.optional(),
    color: color.optional(),
    roster: z.array(RosterEntry).max(30),
  })
  .strict();
const Bench = z.array(RosterEntry).max(30);

const teamKey = z.enum(['A', 'B', 'C']);
const seekMode = z.enum(['TOGETHER', 'RACE']);
const TeamPatch = TeamInput.partial().strict();

export const CreateSessionBody = z
  .object({
    title: z.string().trim().min(1).max(80),
    scheduledDate: isoDate,
    myTeam: teamKey,
    teams: z.object({ A: TeamInput, B: TeamInput, C: TeamInput.optional() }).strict(),
    /** people sitting out to begin with (not arrived yet) */
    bench: Bench.optional(),
    firstHidingTeam: teamKey.optional(),
    seekMode: seekMode.optional(),
    rules: RulesPatchSchema.optional(),
    groupId: id.nullable().optional(),
  })
  .strict()
  .refine((b) => !!b.teams[b.myTeam], 'myTeam must be one of the crews')
  .refine((b) => !b.firstHidingTeam || !!b.teams[b.firstHidingTeam], 'firstHidingTeam must be one of the crews');

/**
 * Between-rounds editor (ADR 0019). Crews' rosters and `bench` (sitting out) place people;
 * every phone follows its owner, and a person left out of every list leaves the night with
 * their phone. A crew set to null is removed (its people sit out unless placed elsewhere); a
 * crew that does not exist yet is added. `moves`: teamKey null takes a phone out of the night
 * (its owner keeps playing without it); a crew moves the phone and its owner (older apps).
 * Phone lists are never sent: they are derived on the server.
 */
export const SetupPatchBody = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    scheduledDate: isoDate.optional(),
    rules: RulesPatchSchema.optional(),
    teams: z.object({ A: TeamPatch.nullable().optional(), B: TeamPatch.nullable().optional(), C: TeamPatch.nullable().optional() }).strict().optional(),
    bench: Bench.optional(),
    moves: z
      .array(z.object({ uid: id, teamKey: teamKey.nullable() }).strict())
      .max(15)
      .optional(),
  })
  .strict();

export const CreateInviteBody = z.object({ targetUid: id.optional(), regenerate: z.boolean().optional() }).strict();
export const PreviewInviteBody = z
  .object({ code: z.string().trim().min(6).max(16).optional(), inviteId: id.optional() })
  .strict()
  .refine((b) => !!b.code !== !!b.inviteId, 'Provide exactly one of code or inviteId');
export const RedeemInviteBody = z
  .object({ code: z.string().trim().min(6).max(16).optional(), inviteId: id.optional(), teamKey: teamKey.optional(), personId: id.optional() })
  .strict()
  .refine((b) => !!b.code !== !!b.inviteId, 'Provide exactly one of code or inviteId');

export const ConsentBody = z
  .object({
    accepted: z.boolean(),
    consentVersion: z.string().min(1).max(20),
    routeSharingAfterRound: z.boolean(),
    guestDisclosureAcknowledged: z.boolean(),
  })
  .strict();

export const HealthInput = z
  .object({
    permission: z.enum(['NOT_DETERMINED', 'DENIED', 'RESTRICTED', 'WHEN_IN_USE', 'ALWAYS']),
    preciseLocation: z.boolean(),
    trackingActive: z.boolean(),
    backgroundSessionActive: z.boolean(),
    lowPowerMode: z.boolean(),
    // Nullable fields may also be omitted: Swift's JSONEncoder drops nil optionals.
    batteryLevel: z.number().min(0).max(1).nullish().transform((v) => v ?? null),
    networkReachable: z.boolean(),
    appVersion: z.string().max(32).nullish().transform((v) => v ?? null),
    queuedSamples: z.number().int().min(0).max(1_000_000),
    lastFixAgeSeconds: z.number().min(0).max(86_400).nullish().transform((v) => v ?? null),
    lastFixAccuracyMeters: z.number().min(0).max(100_000).nullish().transform((v) => v ?? null),
  })
  .strict();

export const ReadyBody = z.object({ ready: z.boolean(), preflight: HealthInput }).strict();
export const StartBody = z.object({ acknowledgeWarnings: z.boolean().default(false) }).strict();

export const SampleInput = z
  .object({
    pointId: z.string().uuid(),
    recordedAt: z.string().datetime({ offset: true }),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    horizontalAccuracyMeters: z.number().min(0).max(100_000),
    speedMetersPerSecond: z.number().min(-1).max(200).nullable().optional(),
    courseDegrees: z.number().min(-1).max(360).nullable().optional(),
    altitudeMeters: z.number().min(-1000).max(10_000).nullable().optional(),
  })
  .strict();

export const LocationBatchBody = z
  .object({
    batchId: z.string().uuid(),
    sentAt: z.string().datetime({ offset: true }),
    samples: z.array(SampleInput).max(500),
    health: HealthInput,
  })
  .strict();

export const CaptureCompleteBody = z.object({ claimId: id }).strict();
export const DecisionBody = z.object({ decision: z.enum(['CONFIRM', 'REJECT']), reason: z.string().trim().max(200).nullable().optional() }).strict();
export const PauseBody = z.object({ kind: z.enum(['MANUAL', 'SAFETY']), reason: z.string().trim().max(200).nullable().optional() }).strict();
export const AbortBody = z.object({ reason: z.string().trim().min(1).max(200), safety: z.boolean().default(false) }).strict();
export const NextRoundBody = z.object({ hidingTeam: teamKey.optional(), seekMode: seekMode.optional() }).strict();
export const DisputeBody = z.object({ resolution: z.enum(['ACCEPT_AS_CATCH', 'KEEP_REJECTED']) }).strict();
export const KeepPhotosBody = z.object({ keep: z.boolean() }).strict();

export const PatchMeBody = z
  .object({
    displayName: name.optional(),
    handle: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.]{3,24}$/, 'Handles are 3–24 characters: letters, numbers, underscore, dot')
      .optional(),
    preferences: z
      .object({
        units: z.enum(['MILES', 'KILOMETERS']).optional(),
        notifyPings: z.boolean().optional(),
        notifyRoundEvents: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const PushTokenBody = z
  .object({
    deviceId: z.string().min(8).max(128),
    fcmToken: z.string().min(10).max(4096),
    apnsEnvironment: z.enum(['development', 'production']),
    appVersion: z.string().max(32).nullable().optional(),
  })
  .strict();

/** ActivityKit tokens are hex. */
const activityToken = z.string().min(16).max(512).regex(/^[0-9a-fA-F]+$/);
export const DeviceIdParam = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** A round's Live Activity push token; the clock offset (phone − server) keeps its timers on server time. */
export const LiveActivityTokenBody = z
  .object({
    pushToken: activityToken,
    clockOffsetMs: z.number().int().min(-86_400_000).max(86_400_000),
  })
  .strict();

/** Push-to-start token for Live Activities on this device; null turns them off. */
export const LiveActivityStartTokenBody = z
  .object({
    deviceId: DeviceIdParam,
    pushToStartToken: activityToken.nullable(),
  })
  .strict();

export const FriendRequestBody = z
  .object({ handle: z.string().trim().toLowerCase().max(24).optional(), inviteToken: z.string().max(64).optional() })
  .strict()
  .refine((b) => !!b.handle !== !!b.inviteToken, 'Provide exactly one of handle or inviteToken');
export const RespondBody = z.object({ accept: z.boolean() }).strict();

export const CreatePersonBody = z.object({ displayName: name, aliases: z.array(name).max(10).optional(), confirmNew: z.boolean().optional() }).strict();
export const PatchPersonBody = z.object({ displayName: name.optional(), aliases: z.array(name).max(10).optional() }).strict();
export const MergePersonBody = z.object({ intoPersonId: id }).strict();
export const LinkRespondBody = z.object({ approve: z.boolean() }).strict();

export const CreateGroupBody = z
  .object({ name, personIds: z.array(id).max(100).default([]), memberUids: z.array(id).max(50).default([]), editorUids: z.array(id).max(50).default([]) })
  .strict();
export const PatchGroupBody = z
  .object({ name: name.optional(), personIds: z.array(id).max(100).optional(), memberUids: z.array(id).max(50).optional(), editorUids: z.array(id).max(50).optional() })
  .strict();
