# @typesys/redis

Redis-backed `Cache` and `RateLimiter` for running more than one TypeS
runtime instance against shared state
([ADR-0025](../../docs/adr/0025-multi-instance-deployment.md)). Optional:
`@typesys/core` never depends on it.

```ts
import { createClient } from "redis";
import { RedisCache, RedisRateLimiter } from "@typesys/redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const runtime = new SemanticRuntime(registry, adapters, policyEngine, {
  cache: new RedisCache(redis),
  rateLimiter: new RedisRateLimiter(redis, { capacity: 100, refillPerSecond: 20 })
});
```

Both take any node-redis v5+ client (they rely only on the small
`RedisCommands` interface).

## `RedisCache`

- Shared by every instance on the same Redis, so one instance's
  `invalidateObject` reaches all of them.
- Values are stored as JSON with a millisecond TTL; they must be
  JSON-serializable.
- `get`/`set` failures degrade to a miss or a skipped write (reported to
  `onError`, default `console.warn`); `delete`/`clear` failures throw.
- `keyPrefix` (default `typesys:cache:`) namespaces keys; `clear()` removes
  only that prefix.

## `RedisRateLimiter`

- A token bucket (`capacity` burst, `refillPerSecond` steady state) evaluated
  atomically in one Lua script, using Redis's clock, so every instance draws
  from one budget per identity.
- Fails closed by default when Redis is unreachable; `failOpen: true` admits
  calls instead and reports the error to `onError`.
- `keyPrefix` defaults to `typesys:ratelimit:`. With `refillPerSecond: 0` a
  bucket never refills and its key never expires.

## Tests

Skipped unless `REDIS_URL` is set, like the Postgres packages' tests:

```bash
REDIS_URL=redis://localhost:6379 npx vitest run packages/redis
```

They include two runtime instances sharing one Redis (a shared rate-limit
budget; one instance's cache fill and invalidation seen by the other).
