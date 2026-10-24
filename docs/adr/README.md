# Architecture decision records

An ADR records a decision that departs from [the product spec](../product-spec.md), or that a future change would otherwise have to rediscover. The spec is the original handoff. Where an accepted ADR disagrees with it, or with an older ADR, the newer ADR wins.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-photo-upload-via-api.md) | Photos are uploaded and served through the API, not signed URLs | Accepted |
| [0002](0002-firestore-layout.md) | Firestore layout differs slightly from the logical model | Accepted, crews updated by 0013 |
| [0003](0003-single-idempotent-tick.md) | One idempotent tick handles every deadline kind | Accepted |
| [0004](0004-host-is-an-operator.md) | The host is always one of the two operators | Superseded in part by 0013 |
| [0005](0005-ping-status-model.md) | Ping status values and pause handling | Accepted, missing pings superseded by 0015 |
| [0006](0006-location-authorization.md) | "While Using" + background activity session instead of "Always" | Accepted |
| [0007](0007-clock-skew.md) | Device timestamps are corrected by the measured clock offset | Accepted |
| [0008](0008-pause-and-abort-authority.md) | Pause, resume and abort authority | Updated by 0013 |
| [0009](0009-tooling.md) | Tooling choices | Accepted |
| [0010](0010-realtime-reconciliation.md) | Firestore listener plus REST reconciliation | Accepted, cadence updated by 0016 |
| [0011](0011-native-ios-design.md) | Native iOS 26 design: Liquid Glass, tab navigation, colour = crew | Accepted, recap and history layout updated by 0020 |
| [0012](0012-cloud-functions-for-firebase.md) | Deploy on Cloud Functions for Firebase with one `firebase deploy` | Accepted, supersedes the v0.1 Cloud Run + Terraform deploy |
| [0013](0013-crews-with-several-phones.md) | Crews with several equal phones, up to three crews, one night code | Accepted, joining and moves updated by 0018, crews and editing by 0019 |
| [0014](0014-open-ended-nights.md) | Open-ended nights | Accepted, editor and night comparison updated by 0019 |
| [0015](0015-waiting-pings.md) | Waiting pings | Accepted |
| [0016](0016-network-efficiency.md) | Network efficiency on cellular | Accepted |
| [0017](0017-live-activities.md) | Live Activities | Accepted, crew label updated by 0019 |
| [0018](0018-phone-owner-plays-on-phone-crew.md) | A phone's owner plays on the phone's crew: joins link to typed names, moved phones take their owner's name | Accepted, moves updated by 0019 |
| [0019](0019-people-make-the-crew.md) | People make the crew: phones follow their owners, people can sit out, crews are named after their people, crews are compared within matchups | Accepted, scorecard extended by 0020 |
| [0020](0020-stats-story-first.md) | Stats tell the story first: highlights, per-person crew rounds and distances, a night map, a replayable round map, share cards; the game map shows one round | Accepted |

## Spec sections changed by ADRs

| Spec says | Now | ADR |
|---|---|---|
| Exactly two phone operators, one per crew; two crews | 2–3 crews, 1–5 equal phones each; one or two seeking crews (Together/Race) | 0013 |
| The host invites the other operator; single-use invites | One reusable night code per night; direct invites for friends | 0013 |
| Typically four rounds, roles alternate | No round count; any crew may hide next; default is the crew that has hidden least | 0014 |
| Missing ping → `NO_FRESH_FIX` | The ping waits, then releases the current position, labelled late | 0015 |
| Cloud Run + Terraform + Secret Manager | Cloud Functions for Firebase, one `firebase deploy`, no secrets at all | 0012 |
| Signed upload URLs | Upload through the API, which strips metadata | 0001 |
| Opponent heartbeat | Coarse crew status, no timestamps | 0016 |
| People and crews are edited separately | A phone's owner is linked to a roster name and moves with the phone | 0018 |
| Crews have typed names; people are on a crew or not | Crews are named after their people; people can sit out; every phone follows its owner | 0019 |
| A night comparison checks each crew's own hiding rosters | Crews must have the same people in every round; matchups compare crews within rounds played the same way | 0019 |
| Round results and the night scorecard list every number with equal weight; static route polylines | A headline, highlights (single-round records credited to crews) and details one tap away; a replayable round map and a night map; share cards made on the phone | 0020 |
| Person stats: team-level time and distance | Also each person's rounds as their crew played them, with crew distances and longest/shortest rounds | 0020 |

## Writing one

Name it `NNNN-short-title.md` with the next number, and keep it short:

```markdown
# ADR NNNN — <decision as a sentence>

**Status:** accepted · **Supersedes/Updates:** ADR xxxx (if any) · **Spec:** §x.y

**Context.** What forced a decision; what was measured or observed.

**Decision.** What we do now, specific enough to check against the code.

**Consequences.** What it costs, what changed shape (API, views, app), what tests prove it.
```

When an ADR supersedes or updates another, also change the older ADR's **Status** line, add a row above, and update every doc the decision touches ([docs/README.md](../README.md) lists what each doc tracks).
