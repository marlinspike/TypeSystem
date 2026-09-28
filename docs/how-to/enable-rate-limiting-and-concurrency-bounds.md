# How to bound concurrency, query size, and rate-limit callers

Query-size limits are on by default (see
[the last section](#bound-how-much-one-query-can-ask-for)). Concurrency and
rate limiting are opt-in-by-omission — a runtime you build with no extra
arguments behaves exactly as it did before ADR-0019: fan-out bounded at
a sane default (20), no rate limiting at all
([ADR-0019](../adr/0019-concurrency-bounds-and-rate-limiting.md)).

## Bound how many adapter calls one fan-out can open at once

The `maxConcurrency` option (in `SemanticRuntime`'s 4th argument). Every relationship
resolution, query page, and computed-property provenance lookup fans out
through this same limit:

```ts
import { SemanticRuntime } from "@typesys/core";

const runtime = new SemanticRuntime(registry, adapters, policyEngine, {
  maxConcurrency: 5 // at most 5 adapter calls in flight at once from one fan-out
});
```

Lower it if your adapter's backing system (a REST API with its own rate
limit, a small connection pool) can't absorb 20 concurrent calls. Raise
it if your adapter is cheap (in-memory, well-provisioned Postgres) and
you'd rather trade more concurrency for lower tail latency on large
fan-outs.

## Rate-limit callers

The `rateLimiter` option:

```ts
import { SemanticRuntime, InMemoryRateLimiter } from "@typesys/core";

const runtime = new SemanticRuntime(registry, adapters, policyEngine, {
  rateLimiter: new InMemoryRateLimiter({ capacity: 100, refillPerSecond: 20 }) // burst of 100, steady-state 20/sec
});
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

## Bound how much one query can ask for

Unlike the two bounds above, this one is **on by default**. `query` input
is validated against `semanticQuerySchema` and these `QueryLimits`
before any policy check or adapter call:

| Limit | Default | Meaning |
|---|---|---|
| `defaultLimit` | 100 | Page size when a query omits `limit`. |
| `maxLimit` | 1000 | Largest `limit` a caller may ask for. |
| `maxIncludes` | 10 | Most `include` entries in the whole include tree, every level counted. |
| `maxIncludeDepth` | 3 | Deepest `include` nesting (a top-level include is depth 1). |
| `maxFilterDepth` | 8 | Deepest `and`/`or` nesting in any one filter, top-level or include-level (a bare condition is depth 1). |
| `maxFilterConditions` | 100 | Most leaf conditions in any one filter. |

Anything over a limit, and any malformed query (unknown fields, a bad
operator, a non-integer `limit`, the same relationship included twice at
one level), throws `InvalidInputError` rather than
being clamped or ignored, so callers learn the bound. Input nested more
than 64 levels deep is rejected before schema validation even runs.

Override any subset with the `queryLimits` option, either on the
`SemanticRuntime` constructor or through `buildRuntime`:

```ts
const { runtime } = await buildRuntime({
  manifests, adapters, policyRules,
  runtimeOptions: { queryLimits: { defaultLimit: 25, maxLimit: 200 } } // the rest keep their defaults
});
```

`defaultLimit` must not exceed `maxLimit`; the constructor throws if it
does. The MCP `query` tool advertises `runtime.queryLimits` in its
`inputSchema`, so agents see your real bounds. The tests are in
[`packages/core/test/input-validation.test.ts`](../../packages/core/test/input-validation.test.ts).

**Paging, not truncation.** Before these limits existed, a query without
`limit` returned every match. It now returns one page; callers follow
`nextCursor` (passed back as `cursor`) for the rest.
