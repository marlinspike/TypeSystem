# 0027. Query DSL Extensions: Sort, Projection, Aggregation, Full-Text

## Status

Proposed — written ahead of implementation (an ADR-first workflow), unlike
the accepted ADRs that describe code already in the tree. It flips to
Accepted, with the concrete "proven, not assumed" evidence (test names,
measured numbers) filled in, when the implementation lands.

## Context

The query DSL (ADR-0011, `packages/core/src/model/query.ts`) models
`filter`, `include`, `limit`, and `cursor` — and nothing else.
`completeness.md` records the gaps directly: no aggregation, no sort, no
full-text, no projection. In practice consumers and agents hit all four
immediately:

- **Sort.** "The ten aircraft with the oldest last-inspection date" is not
  expressible. Worse, `cursor` pagination implies *some* stable order the
  adapter happens to use, but nothing in the contract says what it is, so
  paging is only accidentally stable.
- **Projection.** Every returned object carries all of its visible
  properties (`completeness.md`). An agent that wants a tail number and a
  status still pays to resolve and serialise everything, and a large page
  multiplies that.
- **Aggregation.** "How many aircraft are non-mission-capable, by base" can
  only be done by paging the whole set into the caller and counting there —
  which the page limits (ADR-0019) are specifically designed to prevent.
- **Full-text.** `contains` is substring-only. "Find maintenance events
  whose notes mention corrosion" wants real text search.

All four have to respect the same invariants the current query path already
enforces in `runtime.ts`: property-level policy (`requireFilterableProperties`
rejects a filter on a property the caller can't read, failing closed) and the
computed-property boundary (`rejectComputedFilterProperties` — computed values
don't exist until after the adapter has run). Adding capabilities that quietly
skip those checks would open exactly the leak the existing checks close.

## Decision

Extend the one DSL rather than add a second query language, keep every new
field optional (existing queries are unchanged), and re-use the existing
policy and computed-property guards for each.

**1. Sort.** `SemanticQuery.sort?: { property: string; direction: "asc" |
"desc" }[]`, threaded into `adapter.queryByType(...)`. Sort runs in the
adapter for the same reason filtering does — it's inseparable from
pagination — and the cursor contract tightens to "keyset over the requested
sort keys plus object id," making paging stable by construction. A sort key
that is a computed property is rejected (same error shape as
`rejectComputedFilterProperties`); a sort key the caller can't read is
rejected as a policy denial (same treatment as a hidden filter property),
because ordering by a hidden value leaks that value through position.

**2. Projection.** `SemanticQuery.select?: string[]` (and the same on
`QueryInclude`), returning only the named properties plus the object id.
Projection is applied in the runtime *after* redaction and computed-property
resolution, so you can never project a property you can't read (it is simply
absent), and a computed property still resolves its dependencies internally
even if they aren't selected. As an optimisation the runtime passes the
selected set as the long-unused `propertyNames` argument that
`adapter.resolveProperties(typeName, objectId, propertyNames)` already
accepts (`adapter.ts`) — an adapter may narrow its fetch, but the runtime
owns the authoritative output shape.

**3. Aggregation — a separate shape and entry point.**
`SemanticAggregateQuery = { type, filter?, groupBy?: string[], aggregations:
{ name: string; op: "count" | "sum" | "avg" | "min" | "max"; property?:
string }[] }`, resolved by a new `runtime.aggregate()` and a new
`adapter.aggregate(...)`, returning `{ groups: { key: Record<string,
unknown>; values: Record<string, number> }[] }`. It is deliberately *not*
folded into `SemanticQuery`, because its result is not a list of objects and
overloading `QueryResult<ResolvedObject>` to sometimes mean "aggregation
rows" would corrupt the type every consumer relies on. Aggregation runs in
the adapter (pulling all rows client-side to aggregate is the anti-pattern
the limits exist to stop). `adapter.aggregate` is optional; an adapter that
can't (the mock-REST one) throws `AggregationNotSupportedError` with the
`dataSourceId`, rather than silently returning wrong numbers. Policy fails
closed: aggregating over, or grouping by, a property the caller can't read is
rejected, and object policy still gates the type — otherwise `avg(salary)`
becomes a channel for a value the row-level policy hides.

**4. Full-text — a capability, not a uniform operator.**
`SemanticQuery.search?: { text: string; properties?: string[] }`. The
Postgres adapter implements it with `to_tsvector @@ plainto_tsquery`; the
in-memory adapter falls back to case-insensitive substring. This is the one
place we knowingly break ADR-0011's "every adapter interprets the DSL
identically" rule: full-text ranking and tokenisation are inherently
backend-specific, so the contract is "best-effort text match over the named
properties, semantics documented per adapter," not bit-identical results.
Called out here so the divergence is a decision, not an accident.

**5. Bounds and MCP surface.** `QueryLimits`
(`packages/core/src/runtime/input-validation.ts`) gains caps on sort-key
count, `select` length, aggregation count, `groupBy` cardinality, and
`search.text` length, so the new fields can't become a new unbounded-work
channel. `semanticQuerySchema` grows the optional fields, so the MCP `query`
tool advertises them with zero translation (ADR-0011); aggregation, having a
distinct result, becomes a distinct MCP `aggregate` tool alongside it
(`packages/mcp-server/src/tools.ts`), the same way Actions are tools.

## Consequences

- The four most common "I can't express this" gaps close without a second
  query engine, and without touching consumers that don't use them.
- Cursor pagination becomes well-defined (keyset over an explicit sort),
  fixing the current accidentally-ordered paging.
- Every extension inherits the existing fail-closed policy and
  computed-property guards; none of them can be used to probe a hidden value
  or filter/sort/aggregate on something that doesn't exist yet.
- Adapters gain one required method extension (`queryByType` sort arg) and
  one new optional method (`aggregate`); an adapter that doesn't implement
  aggregation degrades to a clear, typed error, not wrong data.
- Full-text results are explicitly *not* portable across adapters — the sole,
  documented exception to DSL uniformity.

## Alternatives Considered

- **Reconsider GraphQL** (ADR-0011). Projection/field-selection is the one
  GraphQL strength this ADR reproduces. Still rejected for the same reason:
  it would mean a second schema language and execution engine beside JSON
  Schema + MCP, to gain field selection an agent consumer rarely needs.
  Adding a `select` array is a fraction of that cost.
- **One mega-`SemanticQuery` that also carries `aggregations`.** Rejected:
  the result type would have to be a union of "objects" and "aggregation
  rows," which every caller and the MCP output schema would then have to
  discriminate. A separate shape and tool keeps both types honest.
- **Client-side sort/aggregate over a fetched page.** Rejected: it only sees
  one page, so it produces wrong global answers, and it reintroduces the
  unbounded-fetch that ADR-0019 limits exist to prevent.
- **A uniform full-text operator with identical cross-adapter semantics.**
  Rejected as not deliverable honestly: emulating Postgres FTS ranking in the
  in-memory adapter would be a fiction. Better to expose it as a
  per-adapter capability with documented semantics.
- **Push projection entirely into the adapter (SELECT only those columns).**
  Rejected as the authoritative mechanism (it would run before redaction and
  couldn't include computed properties) but kept as an optional optimisation
  hint via the existing `propertyNames` argument.
