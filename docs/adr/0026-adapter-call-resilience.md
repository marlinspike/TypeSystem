# 0026. Adapter Call Resilience: Timeouts, Cancellation, Retries, Circuit Breaking

## Status

Accepted — implemented in `@typesys/core` (`runtime/resilience.ts`, wired
into `SemanticRuntime.getAdapter`), with `AdapterCallOptions` added to the
`Adapter` interface, the mock-REST adapter honoring the signal, and the
Postgres pool default aligned to the concurrency budget. Proven by
`packages/core/test/resilience.test.ts`: a timeout throws `AdapterTimeoutError`
and aborts the call's signal; retries recover a transient read; a
non-idempotent Action is never retried while an idempotent one is; the breaker
opens, fast-fails without calling the adapter, and half-opens after cooldown.

## Context

Every read and every Action ultimately becomes one or more `Adapter` calls
(`packages/core/src/runtime/adapter.ts`). Today that call has no time bound
and no way to be cancelled:

- The `Adapter` interface's four methods take no `AbortSignal` and no
  deadline. A slow or hung backend call runs until it returns on its own.
- `maxConcurrency` (ADR-0019, ADR-0025) bounds *how many* adapter calls one
  request has in flight, never *how long* any one runs. A call that never
  returns holds its concurrency permit forever, so under fan-out a single
  hung backend can drain the whole request budget and stall a request that
  touches several sources — the opposite of what the budget was meant to
  guarantee.
- There is no retry, backoff, or circuit breaker anywhere in `core`, the
  MCP server, or the Postgres adapter. A one-off transient error (a dropped
  connection, a brief 5xx from a mocked REST system) fails the entire
  multi-source read, and a *persistently* down backend is retried — at full
  cost, with a full timeout wait — on every single request against it.
- The defaults are internally inconsistent. `DEFAULT_MAX_CONCURRENCY` is 20
  (`packages/core/src/runtime/runtime.ts`) but the Postgres pool ships
  `max: 10` with `connectionTimeoutMillis: 5_000`
  (`packages/adapter-postgres/src/pool.ts`). One request fanning out to its
  full budget asks for 20 concurrent Postgres calls from a 10-connection
  pool; the 11th onward queue and, after five seconds, fail with a pool
  timeout that is currently indistinguishable from any other error.

This is the liveness half of the resource story ADR-0019/ADR-0025 started on
the concurrency half, and it overlaps `PRODUCTION-READINESS.md` items 2
(hostile-input / resource-exhaustion review), 5 (real load behaviour under
contention), and 12 (rate-limiter / pool tuning).

## Decision

Introduce one small, dependency-free resilience layer that wraps *every*
adapter call at the point the runtime already intercepts them, plus native
backend timeouts, plus a reconciled default for the two concurrency knobs.

**1. `AbortSignal` becomes part of the `Adapter` contract, optionally.** Each
`Adapter` method gains an optional trailing `opts?: { signal?: AbortSignal }`.
This is backward compatible: an adapter that ignores it still compiles and
runs. Well-behaved adapters forward the signal to their client so in-flight
work is actually cancelled (the Postgres adapter sets a per-connection
`statement_timeout` and issues a cancel on the signal; the mock-REST adapter
forwards it to `fetch`).

**2. The runtime enforces a per-call deadline regardless of the adapter.**
The `getAdapter` Proxy (`runtime.ts`) — which already takes a concurrency
permit per call — additionally races each call against a timer. When the
deadline fires it aborts the call's `AbortSignal` (cooperative cancellation),
releases the permit, and throws a new `AdapterTimeoutError`. The race
guarantees the *request* stays live even when an adapter ignores the signal;
the native `statement_timeout`-style backend timeout is what stops the
abandoned work from running on. Two layers on purpose: liveness from the
race, no orphaned work from the native timeout.

**3. Retries with exponential backoff and jitter — for reads only.** Reads
(`resolveProperties`, `queryByType`, `resolveRelationship`) are idempotent
and are retried on *retryable* errors (timeout, connection reset, pool
exhaustion, an adapter-declared transient). `executeAction` is **never**
retried by default, because re-issuing a side effect can double-charge,
double-create, or double-send; an Action is retried only when it declares
itself idempotent through the existing `ActionDefinition.idempotency` field
(`"key"` or `"natural"` — anything other than `"none"`, ADR-0005), and is then
retried the same way. The error taxonomy (`isRetryableError` in
`packages/core/src/runtime/resilience.ts`, using `packages/core/src/runtime/errors.ts`)
decides retryability:
`AuthorizationError`, `InvalidInputError`, `NotFoundError`, and
`PreconditionFailedError` are never retried — retrying them wastes budget and
re-audits denials.

**4. A per-DataSource circuit breaker.** Consecutive failures against one
`dataSourceId` open its breaker for a cooldown, after which calls fail fast
with `CircuitOpenError` instead of paying a full timeout + retry cycle each
time; a half-open probe closes it when the backend recovers. Breaker state is
per process, consistent with the `Semaphore` budget being per process
(ADR-0025) — a shared, cross-replica breaker would need Redis and is listed
under Alternatives, not built.

**5. Configuration: `ResiliencePolicy`, with aligned defaults.** A new
optional `resilience` field on `SemanticRuntimeOptions` sets the default
policy, overridable per `DataSource`:

```ts
interface ResiliencePolicy {
  callTimeoutMs?: number;            // per adapter-call deadline
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  circuitBreaker?: { failureThreshold: number; cooldownMs: number };
}
```

Omitting it preserves today's behaviour exactly (no timeout, no retry, no
breaker), the same "defaults to how it worked before the feature existed"
rule the cache and rate limiter follow. The Postgres pool's default `max` is
raised to match `DEFAULT_MAX_CONCURRENCY` so a single request cannot
self-starve the pool by default, and pool-acquisition timeout is surfaced as
a retryable `AdapterUnavailableError` rather than an opaque failure. The
sizing rule is documented once: `maxConcurrency` bounds one request's
in-flight adapter calls; a pool's `max` bounds one process's total
connections and must be at least `maxConcurrency`, then sized up for expected
concurrent requests.

## Consequences

- A hung backend can no longer stall a request or leak a permit; the request
  fails with a clear `AdapterTimeoutError`/`CircuitOpenError` after a bounded
  wait.
- Transient failures self-heal; a persistently dead backend is tried once per
  cooldown, not once per request, which also protects the backend from a
  thundering-herd on recovery.
- `executeAction` safety is explicit: no Action is retried unless its author
  marked it idempotent, so the resilience layer can never turn one write into
  two silently.
- The breaker is per replica, so N replicas may each probe a recovering
  backend once per cooldown. Acceptable, and noted for the shared-breaker
  follow-up.
- New surface to tune (`PRODUCTION-READINESS.md` item 12): the shipped
  defaults are a starting point, not a validated SLA.
- `core` gains no new runtime dependency — the retry/breaker/timeout logic is
  a small internal module, tested in isolation.

## Alternatives Considered

- **Put resilience inside each adapter.** Rejected: it duplicates the same
  logic in every adapter, and an adapter can't guarantee request-level
  liveness for a call that ignores its own timeout — only the runtime, which
  owns the permit and the fan-out, can.
- **Adopt a resilience library (cockatiel, opossum, p-retry).** Reasonable
  and battle-tested, but `@typesys/core` deliberately carries almost no
  runtime dependencies (ulid, ajv). Timeout + capped-jitter backoff + a
  three-state breaker is ~150 lines; keeping it in-tree avoids pulling a
  dependency (and its transitive tree) into the one package everything else
  builds on. Revisit if the policy surface grows beyond what a small module
  should own.
- **A shared, Redis-backed circuit breaker** so all replicas trip together.
  Deferred for the same reason ADR-0025 kept the `Semaphore` per process: it
  adds a Redis round-trip to the hot path for a benefit (coordinated tripping)
  that per-process breakers approximate well enough. A clean follow-up if a
  real deployment shows replicas hammering a dead backend in aggregate.
- **Retry everything, including Actions, and rely on idempotency keys.**
  Rejected as a default: it assumes every backend honours an idempotency key,
  which the `Adapter` contract can't guarantee. Opt-in per Action is the safe
  inversion.
- **Only raise the pool size / only lower `maxConcurrency`.** Rejected as a
  half-fix: it papers over the pool-starvation symptom without giving a hung
  or flapping backend a bounded, observable failure. The defaults are aligned
  *and* the timeout/breaker are added.
