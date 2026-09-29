# 0025. Multi-Instance Deployment

## Status

Accepted

## Context

Every piece of runtime state was either per-process by design or never
tested across processes (PRODUCTION-READINESS.md item 7):

- `InMemoryCache` (ADR-0016) is per-process. With two replicas, one
  replica's `invalidateObject` never reaches the other, which keeps serving
  stale data until its TTL runs out.
- `InMemoryRateLimiter` (ADR-0019) is per-process. With N replicas behind a
  load balancer, one identity gets N budgets. The load test measured this:
  two processes admitted 798 requests against a budget of about 400.
- `PostgresRegistryStore` (ADR-0015) accepted an "unverified-at-scale
  multi-instance story." Nothing tested two registries on one database, and
  the migration runner had a real race: two runs started together could both
  read "nothing applied" and both try the same migration, so one crashed.
- Nothing measured the runtime under concurrent load at all (item 5).

A related, single-process problem surfaced at the same time: `maxConcurrency`
capped each fan-out level separately, so nested fan-out (a query page, each
item's includes, each include's related objects, each object's computed
properties) multiplied it. One request could hold far more adapter calls in
flight than the setting suggested.

## Decision

**Shared state lives in Redis, behind the existing interfaces.** A new
optional package, `@typesys/redis`, provides `RedisCache` (implements
`Cache`) and `RedisRateLimiter` (implements `RateLimiter`). Nothing in
`@typesys/core` depends on Redis; a deployment opts in by passing them in
`SemanticRuntimeOptions`, exactly like the in-memory ones.

- `RedisRateLimiter` runs the same token bucket as `InMemoryRateLimiter` as
  one Lua script, so each check is atomic, and reads the clock from Redis's
  `TIME`, so clock skew between hosts can't mint extra tokens. It fails
  closed by default: if Redis is unreachable, the call fails with the real
  error rather than a misleading "rate limit exceeded". `failOpen: true`
  chooses availability instead.
- `RedisCache` stores JSON with a millisecond TTL. A failed `get` or `set`
  degrades to a miss or a skipped write, so a Redis outage slows reads but
  doesn't fail them; a failed `delete` or `clear` throws, since a silently
  failed invalidation means stale data.
- `RateLimiter.tryAcquire` may now return a Promise, since a shared limiter
  has to ask a shared store.

**Migrations serialize on a Postgres advisory lock.** Both migration runners
(`registry-store-postgres`, `adapter-postgres`) take
`pg_advisory_lock(hashtext(<tracking table>))` before reading the applied
set, so concurrent runs apply each migration exactly once. If the unlock
fails, the connection is destroyed rather than returned to the pool.

**`maxConcurrency` is one budget per request.** Each top-level runtime call
creates one semaphore of `maxConcurrency` permits, carried through nested
calls with `AsyncLocalStorage`. `getAdapter` returns a view of the adapter
that takes a permit per call, so computed properties and Actions calling
`ctx.getAdapter` count too. Permits are held only for the duration of one
adapter call, never while waiting on nested work, so nesting can't
deadlock; an adapter that re-enters the runtime starts a fresh budget.

**Proven, not assumed.** Tests run two runtime instances against one Redis
(shared rate-limit budget; one instance's cache fill and invalidation seen
by the other) and several registries against one Postgres (concurrent
migrations, cross-instance reads and type composition, an interleaved audit
log, concurrent registration of the same version). `npm run load-test`
starts N server processes and drives them with concurrent MCP clients; CI
runs it for five seconds with two processes sharing Redis and fails if they
admit more than one rate-limit budget or return any unexpected error.

## Consequences

- Running several replicas is a tested configuration: pass `RedisCache` and
  `RedisRateLimiter`, point every replica at the same Postgres and Redis, and
  run migrations as a deploy step (concurrently is now safe).
- Per-identity limits mean the same thing at any replica count.
- Redis becomes a dependency of the deployment (not of the code) as soon as
  either class is used. Its availability affects rate limiting (fail closed
  by default) more than caching (degrades to misses).
- Cached values must be JSON-serializable. A `Date` in adapter output comes
  back as a string.
- Still per-process, by design: `Semaphore` budgets (they bound one
  process's outbound calls), the in-memory adapters, and the demo token map.
  A replica's in-memory adapter data is not shared, which is why the load
  test's workload is read-only.
- The load test is a regression gate on one CI runner, not a capacity claim
  for any real deployment; real numbers depend on real adapters, network,
  and hardware.

## Alternatives Considered

- **Postgres for the rate limiter and cache.** No new dependency, but a
  token-bucket check per request is a write per request, and TTL expiry
  needs a sweeper. Redis does both natively and cheaply.
- **A sticky load balancer, so each identity always reaches one replica.**
  Keeps in-memory limiters "correct" only until a replica restarts or the
  pool resizes, and does nothing for cache invalidation.
- **Dividing the limit by the replica count.** Wrong whenever traffic is
  uneven across replicas or the replica count changes.
- **Taking the concurrency budget as an explicit parameter** through every
  internal call instead of `AsyncLocalStorage`. More visible, but it would
  also have to reach user-written computed-property and Action code through
  `ctx.getAdapter`, which `AsyncLocalStorage` handles without any API change.
