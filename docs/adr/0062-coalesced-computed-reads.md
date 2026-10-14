# 0062. Coalescing Computed Properties' Reads Within One Request

## Status

Accepted. Implemented in `@typesys/core`: a `computedReads` runtime option (`"direct"` by default, or `"coalesce"`) and `ReadCoalescer`, which computed properties reach adapters through when it is `"coalesce"`. Measured by `scripts/benchmark-computed-reads.ts`.

Proven by:

- `packages/core/test/read-coalescer.test.ts`:
  - Six concurrent equality lookups become one `in` query, and each caller gets exactly what its own query returns. That includes a key with no match, a repeated key, and `1` beside `"1"`.
  - An identical read is made once per request. Its answer is frozen, so one computation cannot change what another receives, and a write to it throws.
  - The adapter's own records are copied, never frozen or shared.
  - Nothing is shared between requests, and a failed read is not remembered.
  - A limited, sorted or paged query, and any condition other than equality, is read as asked.
  - Lookups are made one by one when the adapter cannot filter the property exactly. That covers four cases: `canFilter` denies `in` or `eq`, the property is protected at rest, or the adapter's answer is malformed or throws.
  - When the combined answer comes back paged or fails, each caller's own query runs instead.
- `packages/domain-airforce/test/computed-read-coalescing.test.ts`:
  - The setup is three generated fleets of 60 aircraft, with mixed statuses, maintenance events and open and closed work orders.
  - Five queries are run for the maintainer, the viewer and an anonymous caller: a plain page, filters on `needsAttention` and `readinessStatus` (computed), a projection, and a two-level include. Every answer, refusals included, is identical with reads coalesced or direct, across every page.
  - A 200-aircraft page reaches the maintenance system fewer than an eighth as many times.

Mutation-checked: 13 mutations, each failing at least one test.

- Splitting: the combined answer not split back per value.
- Pass-through:
  - a limited query coalesced;
  - a non-equality condition batched;
  - a paged combined answer trusted.
- Isolation:
  - the combined answer neither copied nor frozen;
  - adapter records frozen in place;
  - a shared answer left writable;
  - a failure remembered.
- Eligibility:
  - `in` support not checked;
  - a protected field batched;
  - a failed capability check treated as yes.
- Scope:
  - a coalescer per object instead of per request;
  - the option ignored.

## Context

The baseline named `airforce.Aircraft.needsAttention` as the query hotspot (ADR-0022's consequences already did). Every operational aircraft on a page looks up its maintenance events in the maintenance system. Each one with events then lists every work order. A page of 200 aircraft with a maintenance history makes 225 calls to that system for one value, almost all of them the same call with a different key, or simply the same call.

The runtime already resolves a page's objects concurrently, bounded by `maxConcurrency` (ADR-0019), and computed code reaches adapters through `ctx.getAdapter`. What it lacked was any notion that those calls belong to one request.

## Decision

**Coalesce inside the request, below the computed code.** With `computedReads: "coalesce"`, `ctx.getAdapter` in a computed property returns a view of the same adapter, owned by the request's context (one per top-level runtime call, like the concurrency budget). The view does two things:

- **Identical reads are made once.** The same `queryByType` or `resolveProperties` call within the request shares one answer.
- **Concurrent equality lookups are batched.** Calls to `queryByType(type, { property, operator: "eq", value })` with no limit, cursor or sort, made in the same burst of concurrent computations, become one `{ operator: "in" }` query. The answer is split back per value with `matchesFilter`, in the adapter's order.

**Batch only where the split is exact.** An `in` answer splits into exactly what each `eq` would have returned only if the adapter evaluates both as `matchesFilter` does. The view uses the rule authorization pushdown already uses (ADR-0040): the adapter says so through `canFilter` for both operators, or, saying nothing, the property is not one it protects at rest. A failed or paged combined answer falls back to each caller's own query. The worst case is therefore the old behavior plus one wasted call.

**Share answers, never records.** A shared answer is copied once and frozen. The adapter's own records are never exposed or frozen, and no computation can change what another reads. A copy per caller was measured first: it cost more than the calls it saved.

**Opt-in.** Every runtime option defaults to the behavior before it existed. That matters here, because coalescing is a trade-off, not a free win:

- It defers each burst of lookups by one event-loop turn and adds a copy, which costs time when the lookups are cheap.
- Where they find nothing, as in the standard benchmark, the page is slower: about 18 ms against 15.6 ms at p50.
- Computations now receive frozen answers, and one that wrote to what it read would start to throw.

Nothing else changes:

- Computed values are still computed per object.
- They are still validated against their schema, withheld when their inputs are (ADR-0052), classified (ADR-0032) and audited per object.
- Adapter calls still take the request's budget and resilience policy.
- Actions' preconditions are not coalesced.

## Consequences

Measured with `scripts/benchmark-computed-reads.ts` (two runs, p50; [evidence](../evidence/computed-reads-2026-10-13.md)). The setup is a page of 200 aircraft with a maintenance history, read with `needsAttention`.

| Latency per call | Calls per page, direct | Calls per page, coalesced | p50, direct | p50, coalesced |
|---|---|---|---|---|
| 0 ms | 225 | 14 | 42.7, 43.7 ms | 31.3, 30.1 ms |
| 2 ms | 225 | 12 | 48.7, 53.5 ms | 42.2, 43.1 ms |
| 10 ms | 225 | 12 to 13 | 134.1, 135.2 ms | 109.4, 109.1 ms |

Coalescing cuts the calls a page puts on the maintenance system by about 16 times, and time by about 20% to 30%. Time falls far less than calls because round trips, not calls, set the wall time. The runtime still resolves at most `maxConcurrency` objects at once, so a page takes about as many bursts as before, each now one call instead of up to twenty. Resolving more objects at once is a separate decision about the concurrency budget, not taken here.

Not done:

- No batching of `resolveProperties` by id, of relationship resolution, or of reads across requests. A cache does the last (ADR-0016).
- The execution plan (ADR-0054) still reports computed calls per object, not per request.
- No adapter-level batch API: `in` is the only batch form, so an adapter that cannot filter by membership gets the identical-read sharing only.

## Alternatives Considered

- **A batch API on computed properties** (`computeMany(objects)`). It is the most efficient option, but every computed property would be written twice, and a domain author would have to get batching right by hand. Coalescing below the existing `ComputeContext` changes no domain code: `computeNeedsAttention` is untouched.
- **A DataLoader dependency.** The same idea, but it batches by key with a loader per lookup, which computed code would have to create and share. The view needs no new API, and the `in` split it needs is a few lines over `matchesFilter`.
- **On by default.** It was measured first, and it is slower where lookups are cheap or empty. Its frozen answers are also a behavior change for code that writes to what it read. A deployment that measures a win turns it on.
