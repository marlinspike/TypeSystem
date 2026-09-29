# How to run more than one instance

One process holds its cache and rate-limit budgets in memory. As soon as
there are two replicas behind a load balancer, both need to live somewhere
shared, or each replica serves its own stale cache and grants each identity
its own budget ([ADR-0025](../adr/0025-multi-instance-deployment.md)).

## What each replica needs

| State | Single process | Several replicas |
|---|---|---|
| Registry (types, actions, audit log) | `InMemoryRegistryStore` | `PostgresRegistryStore`, same database for all ([`use-postgres.md`](use-postgres.md)) |
| Cache | `InMemoryCache` | `RedisCache` from `@typesys/redis`, same Redis for all |
| Rate limiter | `InMemoryRateLimiter` | `RedisRateLimiter` from `@typesys/redis`, same Redis for all |
| Your data | Your adapters | Your adapters, pointing at the shared systems of record |

## Wire it up

```ts
import { createClient } from "redis";
import { buildRuntime } from "@typesys/core";
import { RedisCache, RedisRateLimiter } from "@typesys/redis";
import { PostgresRegistryStore, createPool } from "@typesys/registry-store-postgres";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const { runtime } = await buildRuntime({
  store: new PostgresRegistryStore(createPool(), bindings),
  manifests,
  adapters,
  policyRules,
  runtimeOptions: {
    cache: new RedisCache(redis),
    rateLimiter: new RedisRateLimiter(redis, { capacity: 100, refillPerSecond: 20 })
  }
});
```

Every replica runs the same code against the same `REDIS_URL` and
`DATABASE_URL`. Use a distinct `keyPrefix` per environment if several share
one Redis.

## Migrations

Run them as a deploy step, as before (`npm run migrate:postgres`). Running
that step on several replicas at once is safe: each migration runner takes
a Postgres advisory lock, so exactly one run applies each migration and the
others wait, then find it applied.

## Invalidation reaches every replica

With `RedisCache`, `runtime.invalidateObject(typeName, objectId)` on any
replica clears the shared entry, so the next read on *any* replica goes back
to the adapter. Call it wherever your code knows it just wrote fresh data.

## When Redis is unavailable

- **`RedisRateLimiter`** fails closed: the runtime call fails with the
  connection error. Pass `failOpen: true` to admit calls instead (and an
  `onError` to log them) if availability matters more than enforcement.
- **`RedisCache`** degrades: a failed read is a cache miss and a failed write
  is skipped, reported to `onError` (default `console.warn`). Reads get
  slower, not broken. A failed `invalidateObject` throws, since silently
  keeping stale data would be worse.

## Load-test it

`npm run load-test` starts several server processes and drives them with
concurrent MCP clients, then reports throughput, latency percentiles, and
errors:

```bash
npm run build
# Two processes, shared Redis, a per-identity limit of 200 burst + 50/s:
REDIS_URL=redis://localhost:6379 RATE_LIMIT_CAPACITY=200 RATE_LIMIT_REFILL_PER_SECOND=50 npm run load-test
# Same, without Redis: shows each process granting its own budget.
RATE_LIMIT_CAPACITY=200 RATE_LIMIT_REFILL_PER_SECOND=50 npm run load-test
```

Tune with `LOAD_INSTANCES`, `LOAD_CONCURRENCY`, `LOAD_DURATION_S`, and
`MOCK_REST_LATENCY_MS` (the simulated backend latency). It exits non-zero
on any unexpected error, or if replicas sharing Redis admit more than one
budget; CI runs a five-second version on every push. The numbers describe
the machine it ran on, not your deployment; see
[`scripts/load-test.ts`](../../scripts/load-test.ts).

## Not shared, by design

- The per-request concurrency budget (`maxConcurrency`) bounds one
  process's outbound adapter calls, so it stays per process.
- The demo in-memory adapters hold separate copies of the sample data per
  replica. Real adapters point at shared systems of record.
