---
"@typesys/core": minor
---

**Breaking:** `SemanticRuntime`'s optional constructor arguments are now one options object. Replace `new SemanticRuntime(registry, adapters, policyEngine, cache, ttl, rateLimiter, maxConcurrency)` with `new SemanticRuntime(registry, adapters, policyEngine, { cache, defaultCacheTtlMs: ttl, rateLimiter, maxConcurrency, queryLimits })` (every field optional; see `SemanticRuntimeOptions`). Passing a `Cache` as the 4th argument throws a `TypeError` naming the fix instead of silently dropping it. `buildRuntime` takes the same object as `runtimeOptions`.
