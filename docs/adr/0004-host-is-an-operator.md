# ADR 0004 — The host is always one of the two operators

**Status:** superseded in part by ADR 0013 (several equal phones per crew; no lead phone) · **Spec:** §1 ("exactly two participating phone operators"), §7.1 screen 5

The creator chooses which crew their phone operates and invites the other operator. A third, non-playing "organizer" account is not supported in v1 — it would be a third tracked/untracked device with ambiguous privileges. The host has **no** data privilege: hosting only grants setup, invites, start and next-round actions. Tests run with the host as the seeker to prove it.
