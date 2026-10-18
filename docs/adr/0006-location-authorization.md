# ADR 0006 — "While Using" + background activity session instead of "Always"

**Status:** accepted · **Spec:** §5.2

The app requests When-In-Use authorization and runs `CLLocationUpdate.liveUpdates` inside a `CLBackgroundActivitySession` (iOS 17+) and `CLServiceSession(authorization: .whenInUse)` (iOS 18), started from a foreground action (tapping Ready / round start). Apple documents that this continues delivering updates in the background with the system's location indicator, without requesting Always. Activity configuration: `.fitness` for the hiding (walking) operator, `.automotiveNavigation` for the seeking (passenger) operator. If the system terminates the app during an active session, it relaunches it; `resumeIfNeeded()` recreates the session after checking local authorization and the persisted context, then the server confirms the round is still active. Force-quit stops tracking (documented, surfaced as "Tracking stopped").
