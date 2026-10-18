# ADR 0001 — Photos are uploaded and served through the API, not GCS signed URLs

**Status:** accepted · **Spec:** §3.3, §10.1 (`captures/init` "signed URL or backend upload"), §11.4

**Decision.** `captures/init` returns a short-lived (10 min), seeker-bound upload ticket; the app `PUT`s the JPEG to the API, which validates size/type, strips EXIF/XMP/ICC/maker-note/comment segments, hashes it and stores it in the private bucket. Reads go through `GET …/captures/{cid}/photo`, which re-authorizes against the round's operators on every request and responds `Cache-Control: private, no-store`.

**Why.** Server-side metadata stripping is guaranteed (signed-URL uploads would store the original bytes), authorization is checked per read instead of embedded in a bearer URL, and no `iam.serviceAccounts.signBlob` grant is needed. Photos are ≤ 8 MB, well under Cloud Run's request limit.

**Consequences.** API instances carry upload bandwidth (negligible for two phones). If photo volume grows, switch to signed URLs + a Cloud Storage–triggered sanitizer.
