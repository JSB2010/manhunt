# ADR 0007 — Device timestamps are corrected by the measured clock offset

**Status:** accepted · **Spec:** §5.3 ("timestamps and trust bounds validated by backend")

Each location batch carries `sentAt` (device clock). The server computes `skew = receivedAt − sentAt`; if |skew| > 2 s, every sample's `recordedAt` is shifted by `skew` (flag `CLOCK_CORRECTED`, original kept as `deviceRecordedAt`); if |skew| > 1 h the batch's samples are flagged `CLOCK_UNTRUSTED` and never released as pings. Samples claiming to be from the future are flagged `FUTURE_TIMESTAMP` and ineligible. This prevents a phone with a wrong clock from presenting a stale fix as fresh. Residual error ≈ one-way network latency.
