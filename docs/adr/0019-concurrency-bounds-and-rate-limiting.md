# 0019. Bounded Concurrency and Rate Limiting

## Status

Accepted

## Context

The N+1 fix (see `SemanticRuntime.getRelationship`/`query`, and the
`n-plus-one.test.ts` suite it shipped with) replaced sequential adapter
calls with an unbounded `Promise.all`/`Promise.allSettled` fan-out: every
related object, every query-page item, every `include`, resolved
concurrently, all at once. That was the right fix for the sequential-
round-trip problem, but it traded one failure mode for another: an
Aircraft with 50 components was fine; a Type with a one-to-many
relationship pointing at 50,000 rows, or a `query` with a large `limit`,
now opens 50,000 simultaneous adapter calls (and, for `adapter-postgres`,
50,000 simultaneous connection-pool checkouts) in one runtime call. There
was also, separately, no defense at all against a single caller (human,
misbehaving script, or a runaway AI agent loop) issuing calls faster than
the runtime — or the systems behind its adapters — can absorb.

These are two related but distinct problems, both about protecting the
runtime and whatever is behind its adapters from being overwhelmed by a
single logical operation or a single caller, and both get the same
treatment as every other cross-cutting concern in this codebase
(`Adapter`/`RegistryStore`/`PolicyEngine`/`Cache`): a small interface,
one built-in implementation, a documented extension point for anything
fancier.

## Decision

### Bounded concurrency for every fan-out

`mapWithConcurrency`/`mapWithConcurrencySettled`
(`packages/core/src/runtime/concurrency.ts`) replace the raw
`Promise.all`/`Promise.allSettled` calls in `getRelationship`, `query`
(both the item-level fan-out and the per-item `include` fan-out), and
`getProvenance`'s computed-property dependency fan-out. Each runs a fixed
number of concurrent workers pulling from a shared queue — bounded by
`SemanticRuntime`'s `maxConcurrency` constructor argument (default 20) —
rather than spawning one promise per item. Output order always matches
input order, regardless of completion order, so nothing downstream needed
to change.

This is a pure internal implementation swap: the N+1 fix's own test
(`n-plus-one.test.ts`) still passes unmodified, because 8-way fan-out is
well under the default limit of 20 and still measurably concurrent
(`maxConcurrent > 1`).

### A `RateLimiter` interface, checked once per public runtime call

```ts
export interface RateLimiter {
  tryAcquire(key: string): boolean;
}
```

(`packages/core/src/runtime/rate-limiter.ts`). `InMemoryRateLimiter` is a
per-key token bucket (`capacity`, `refillPerSecond`); `NoopRateLimiter`
always returns `true`. `SemanticRuntime` takes an optional
`rateLimiter?: RateLimiter` constructor argument (6th positional, after
`cache`/`defaultCacheTtlMs`) — omit it and `NoopRateLimiter` is used, so
every existing caller/test behaves exactly as before (backward
compatible, same pattern ADR-0016 established for `Cache`).

`SemanticRuntime.checkRateLimit(identity)` is called as the first thing
inside `getObject`, `getRelationship`, `query`, `getProvenance`,
`listActions`, and `invokeAction`, keyed by `identity.subjectId`. On
exhaustion it throws `RateLimitExceededError` — a new sibling to
`AuthorizationError`/`PreconditionFailedError` in
`packages/core/src/runtime/errors.ts` — which every existing consumer
already handles the same way it handles any other thrown runtime error
(MCP's tool/resource handlers turn it into an error response; nothing
MCP-specific needed to change).

### Rate-limit cost scales with the work actually done, deliberately

Because `getRelationship` calls the (rate-limited) `getObject` internally
for its fan-out, `query`'s `include` handling calls the (rate-limited)
`getRelationship` internally, and `getProvenance` recurses into itself for
a computed property's dependencies, a single external call can consume
more than one token when it does more underlying work. This is
intentional, not an oversight: the whole point of rate limiting here is
protecting the runtime and its adapters from being overwhelmed, and the
actual load a call places on those adapters is proportional to how much
internal fan-out it triggers, not to how many times an external caller
happened to invoke a method. A `query` with `include` across a 500-row
page that resolves 500 relationships really did do roughly 500x the work
of a bare `getObject`, and a rate limiter that only counted the one
outermost call would let exactly the amplification attack bounded
concurrency is separately guarding against slip past the rate limiter
entirely.

## Consequences

- `maxConcurrency` is one setting shared by every fan-out site in one
  runtime instance, not tunable per-relationship/per-query. That is a
  deliberate simplicity choice for this pass — see Alternatives
  Considered — and is a documented extension point if a real workload
  ever needs per-call tuning.
- `InMemoryRateLimiter` is per-process, same scoping caveat as
  `InMemoryCache` (ADR-0016) and `PostgresRegistryStore`'s
  not-yet-verified multi-instance story (ADR-0015): two replicas each
  enforce their own independent budget for the same identity. A
  distributed rate limiter (Redis-backed token buckets, e.g.) is a
  documented, not-built extension point behind the same `RateLimiter`
  interface.
- A caller doing a large fan-out (a big `query` page with `include`, or a
  relationship with many related objects) is more likely to hit its rate
  limit than one doing simple `getObject` calls — by design, per the
  Decision section above, since it is placing proportionally more load
  on the system.
- Both mechanisms are opt-in-by-omission: a project that never passes a
  `maxConcurrency` override or a `RateLimiter` gets today's unbounded
  concurrency's replacement (bounded at a sane default of 20) and no rate
  limiting at all — nothing about existing behavior changes unless a
  deployment explicitly asks for stricter bounds.

## Alternatives Considered

- **Per-relationship/per-query `maxConcurrency` overrides** (analogous to
  `Mapping.cacheTtlMs`): rejected for this pass — bounded concurrency here
  is a resource-protection mechanism for the runtime and its adapters as a
  whole, not a per-Type authoring concern the way caching or
  resolution-mode is. One runtime-level setting is the honest amount of
  configurability this problem needs; a per-call override is a documented
  extension point if a real workload proves it's needed.
- **A hard cap on fan-out size (reject anything over N items) instead of
  bounding concurrency**: rejected — that changes correctness (a caller
  asking for a relationship with 50,001 related objects gets an error
  instead of an answer) to solve a resource problem. Bounding concurrency
  answers the same question (don't overwhelm the adapter) without ever
  refusing a legitimately large, valid request.
- **Rate-limiting only at the MCP transport layer** (`resources.ts`/
  `tools.ts`), not inside `SemanticRuntime`: rejected for the same reason
  ADR-0009 enforces policy exactly once, in the runtime — a second
  consumer (the demo web app's direct `SemanticRuntime` calls, a future
  HTTP transport) would otherwise need to reimplement rate limiting
  itself or go unprotected. `RateLimiter` lives at the one boundary every
  consumer already goes through.
- **Rate-limiting only the outermost call, ignoring internal fan-out
  cost**: rejected — see Decision's "cost scales with work actually
  done" section. Counting only outermost calls would make the rate
  limiter blind to exactly the amplification pattern bounded concurrency
  exists to guard against.
- **A leaky-bucket or fixed-window counter instead of a token bucket**:
  rejected — a token bucket allows short legitimate bursts (a page load
  that fires a handful of calls at once) while still enforcing a steady-
  state rate, which better matches how a real UI or agent actually calls
  this runtime than a fixed window's edge-effects (a caller doing 2x its
  quota split exactly across a window boundary).
