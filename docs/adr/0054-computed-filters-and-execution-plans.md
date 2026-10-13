# 0054. Filtering on Computed Properties, and Explainable Execution Plans

## Status

Accepted — implemented in `@typesys/core` (`runtime/execution-plan.ts`:
`splitFilter`, the scan cursor, `ExecutionPlan`; `SemanticRuntime.query`'s
scan loop; `explainQuery`'s new `execution`; `QueryLimits.maxScanned`) and
`@typesys/mcp-server` (`typesys_explain_query`). Proven by:

- `packages/core/test/computed-filter-pagination.test.ts`: every page
  sequence, at seven page sizes, returns exactly the matching readable rows
  in order and once each; 60 generated filters (conditions, `and`, `or`,
  nesting), page sizes and sorts agree with a brute-force reference that
  finalizes every row and applies the whole filter; stored conjuncts reach
  the adapter and an `or` is never split; `maxScanned` gives a short page
  whose cursor resumes exactly; an adapter returning more rows than asked
  loses and repeats nothing; foreign and mismatched cursors are refused; and
  `explainQuery` reports the same pushdown the adapter receives and the same
  residual the runtime applies, reading no data.
- `packages/domain-airforce/test/computed-property-filter.test.ts`: filters
  on `needsAttention` and `readinessStatus`, alone and inside `and`/`or`;
  the viewer's filter on the withheld `readinessStatus` matching nothing for
  every value, and on the released `needsAttention` working.
- `packages/mcp-server/test/action-preview-tools.test.ts`: the MCP tool
  returns the execution plan and no authorization plan.

Mutation-checked (6 mutations), each failing at least one test: the
residual filter skipped; a conjunct split by its own top-level property
rather than every property in it; the probe drop removed; a resume cursor
off by one; the consumed rows of an over-full page not skipped.

## Context

ADR-0027 refused a top-level filter naming a computed property, since the
adapter, where the filter ran, has only stored values; ADR-0022's
computed properties (`needsAttention`, combining two systems) are exactly
what applications want to filter on. Callers filtered pages client-side,
which broke paging (an empty page with more matches behind it) and put the
rule outside the boundary. The SDK in the roadmap would have had to do the
same.

Separately, `explainQuery` (ADR-0038) said how a query would be
*authorized* but not how it would *run*: where each part of the filter
executes, which systems are called per object, what includes fan out to.
Agents and developers composing queries need that to know what a query
costs and why a page is short.

## Decision

**Split the filter at its top-level conjunction.** Conjuncts that name only
stored properties go to the adapter as before (with the authorization
predicate, ADR-0038). Conjuncts that name a computed property anywhere run
in the runtime, after the object is authorized, computed and redacted, on
the values the caller may see. An `or` is never split: half of a
disjunction is not a sound pre-filter. A withheld or redacted value is
absent when the residual runs, so it matches uniformly whatever the hidden
value is (ADR-0052); a value marked out by its provenance drops the row as
any probe does (ADR-0032).

**Refill pages, bounded.** With a residual, `query` reads adapter pages
sized to what could still be returned until the page is full, the source
is exhausted, or `QueryLimits.maxScanned` (default 1000) rows were read in
this call. The cursor it returns is opaque and names the adapter cursor of
the page it stopped in plus how many of that page's rows it consumed, so the
next call resumes exactly. A short page with a cursor was already normal
(ADR-0030); this keeps it so. Such a cursor is refused on a query without a
residual, and a foreign cursor on one with a residual.

**Sorting by a computed property is still refused.** A correct order needs
every matching row computed first; that is a materialization, not a page.

**Describe execution from the same decisions.** `explainQuery` now returns
`execution`: the steps `query` would take, in order (classification gate,
scan with its pushdown filter, override merges, per-row authorization,
computed properties, redaction, residual filter, projection, each include
with its source), the adapter calls per object, and plain-language notes.
It is built from the same `splitFilter` call and mapping resolution `query`
uses, so the report cannot drift from what runs. MCP's
`typesys_explain_query` returns only `execution`; the authorization plan
stays in-process, as ADR-0038 decided.

The query DSL (ADR-0011) remains the intermediate representation. A second
IR was considered and not needed: the DSL is already typed, validated and
serializable, and the SDK compiles to it.

## Consequences

- Filters on computed properties work everywhere a filter is accepted:
  in-process, over MCP, and from the SDK.
- A residual filter costs the computed properties of every scanned row, not
  just the returned ones. `maxScanned` bounds it per call; the explain notes
  say so.
- The scan cursor depends on the adapter returning rows in a stable order
  for a given cursor, the same assumption every cursor already makes.

## Alternatives Considered

- **Push computed properties down by translating them to adapter filters.**
  Only possible for a computed property whose compute function is a known
  expression; ours are arbitrary functions, some calling other systems.
- **Materialize computed values at write time.** That is the unbuilt
  `materialized` resolution mode (no ingestion pipeline); worth doing for
  hot filters, but not a precondition for correct filtering.
- **A separate query IR and optimizer.** More machinery than the problem
  needs today; the explain output gives the visibility an optimizer would,
  and the split is the one optimization that matters for correctness.
