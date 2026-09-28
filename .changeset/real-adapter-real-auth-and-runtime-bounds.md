---
"@typesys/core": minor
"@typesys/adapter-postgres": minor
"@typesys/auth-oidc": minor
"@typesys/mcp-server": patch
---

Add a real PostgreSQL-backed `Adapter` (`@typesys/adapter-postgres`) and real OIDC/JWT identity resolution (`@typesys/auth-oidc`, ADR-0018), wired into `mcp-server` as a drop-in `IdentityResolver`. In `core`, bound every relationship/query/provenance fan-out to a fixed concurrency limit and add an opt-in per-identity `RateLimiter` (ADR-0019).
