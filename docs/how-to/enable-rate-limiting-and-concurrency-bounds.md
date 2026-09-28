# How to bound concurrency and rate-limit callers

Both are opt-in-by-omission — a runtime you build with no extra
arguments behaves exactly as it did before ADR-0019: fan-out bounded at
a sane default (20), no rate limiting at all
([ADR-0019](../adr/0019-concurrency-bounds-and-rate-limiting.md)).

## Bound how many adapter calls one fan-out can open at once

`SemanticRuntime`'s 7th constructor argument. Every relationship
resolution, query page, and computed-property provenance lookup fans out
through this same limit:

```ts
import { SemanticRuntime } from "@typesys/core";

const runtime = new SemanticRuntime(
  registry, adapters, policyEngine,
  undefined, undefined, undefined, // cache, defaultCacheTtlMs, rateLimiter — omit for defaults
  5 // maxConcurrency — at most 5 adapter calls in flight at once from one fan-out
);
```

Lower it if your adapter's backing system (a REST API with its own rate
limit, a small connection pool) can't absorb 20 concurrent calls. Raise
it if your adapter is cheap (in-memory, well-provisioned Postgres) and
you'd rather trade more concurrency for lower tail latency on large
fan-outs.

## Rate-limit callers

`SemanticRuntime`'s 6th constructor argument:

```ts
import { SemanticRuntime, InMemoryRateLimiter } from "@typesys/core";

const runtime = new SemanticRuntime(
  registry, adapters, policyEngine,
  undefined, undefined, // cache, defaultCacheTtlMs
  new InMemoryRateLimiter({ capacity: 100, refillPerSecond: 20 }) // burst of 100, steady-state 20/sec
);
```

Every call to `getObject`, `getRelationship`, `query`, `getProvenance`,
`listActions`, and `invokeAction` checks the limiter first, keyed by
`identity.subjectId` — an identity that exhausts its budget gets a
`RateLimitExceededError` thrown back (a sibling of `AuthorizationError`;
MCP's tool/resource handlers already turn any thrown error into an error
response, so nothing else needs to change).

A call that internally fans out — `getRelationship` resolving 50 related
objects, `query` with an `include` across a page of results — consumes
more than one token, proportional to how much work it actually triggers.
This is deliberate (see ADR-0019): the limiter is protecting the runtime
and its adapters from load, and load scales with fan-out, not with how
many times an external caller happened to invoke a method.

## `InMemoryRateLimiter` is per-process

Same caveat as `InMemoryCache` ([ADR-0016](../adr/0016-caching.md)): two
runtime instances (two replicas) each enforce their own independent
budget for the same identity. A distributed rate limiter (Redis-backed
token buckets) is a documented, not-built extension point — implement
the one-method `RateLimiter` interface
(`packages/core/src/runtime/rate-limiter.ts`) and pass it in the same
constructor slot.

## Verify it

Follow [`packages/core/test/concurrency.test.ts`](../../packages/core/test/concurrency.test.ts)
(bounded fan-out never exceeds its limit, still genuinely concurrent) and
[`packages/core/test/rate-limiting.test.ts`](../../packages/core/test/rate-limiting.test.ts)
(budget exhaustion throws, refills over time, tracked independently per
identity, and omitting a `RateLimiter` entirely stays unlimited).
