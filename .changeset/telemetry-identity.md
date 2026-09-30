---
"@typesys/core": minor
---

Telemetry identity policy (ADR-0045). New runtime option `telemetryIdentity`: `"clear"` (the default, `typesys.identity.subject_id` as before), `"none"` (no identity on any span), or `{ mode: "pseudonymous", key }` (`typesys.identity.pseudonym`, a 128-bit HMAC-SHA-256 of the subject id under a key of at least 32 bytes). A malformed policy — including an explicit `null` — throws at construction. Audit rows keep the subject id.
