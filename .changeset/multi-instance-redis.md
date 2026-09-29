---
"@typesys/core": minor
"@typesys/redis": minor
"@typesys/domain-airforce": minor
"@typesys/registry-store-postgres": patch
"@typesys/adapter-postgres": patch
---

Multi-instance deployment (ADR-0025). New `@typesys/redis` package with `RedisCache` and `RedisRateLimiter`, so every replica shares one cache (including invalidation) and one rate-limit budget per identity. `RateLimiter.tryAcquire` may now return a Promise. Both Postgres migration runners take an advisory lock, so running migrations from several replicas at once is safe. `buildAirforceTestbed` accepts `runtimeOptions` and `mockRestLatencyMs`. New `npm run load-test` drives N server processes with concurrent MCP clients.
