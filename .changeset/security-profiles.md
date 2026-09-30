---
"@typesys/core": minor
"@typesys/encryption": minor
---

Security profiles (ADR-0046). New runtime option `securityProfile` accepting `HIGH_ASSURANCE_V1` (`typesys:high-assurance:1`), a versioned set of guarantees checked at construction: `rowSecurity` is `"require-exact"`; aggregation over row-scoped data is admitted only by an exact plan whose engine vouches `planAssurance: "structural"` (the ABAC combinators do; hand-written plans and Cedar's partial evaluation don't); `telemetryIdentity` is `"none"` (the default under the profile) or pseudonymous; no adapter or cache reports local or unknown `keyManagement`; no `demonstration` classification scheme; no unknown option names or malformed engines, schemes, or caches. Weaker explicit settings are refused, every violation reported in a `SecurityProfileError`; `runtime.securityProfile` and `explainQuery` report the profile. `KeyProvider` gains `management` (`LocalKeyProvider` `"local"`, `WrappedKeyProvider` `"managed"`), and `EncryptingAdapter` and `EncryptedCache` expose `keyManagement`. `DEMO_LINEAR_CLASSIFICATION` and `securityLabels` are marked `demonstration`.
