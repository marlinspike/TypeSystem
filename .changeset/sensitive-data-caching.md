---
"@typesys/core": minor
"@typesys/encryption": minor
"@typesys/redis": minor
---

Sensitive-data caching (ADR-0036). `Cache` now declares `confidential: boolean` (`InMemoryCache` and `NoopCache` are confidential, `RedisCache` is not), and `Adapter` gains an optional `sensitiveFields(typeName)` (implemented by `EncryptingAdapter`). The runtime never puts a sensitive value — of a marked Type or member, marked in its provenance, in an adapter-protected field, or computed from any of those — into a cache that isn't confidential: such cached-mode reads bypass the cache and go live, counted as `typesys.cache.requests{result="bypass"}`. New `EncryptedCache` in `@typesys/encryption` wraps any cache, sealing values with AES-256-GCM bound to their cache key and expiry and replacing cache keys with an HMAC, so a shared Redis can hold sensitive Types.
