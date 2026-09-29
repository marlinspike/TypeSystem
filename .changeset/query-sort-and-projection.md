---
"@typesys/core": minor
"@typesys/adapter-in-memory": minor
"@typesys/adapter-mock-rest": minor
"@typesys/adapter-postgres": minor
---

Query DSL sort and projection (ADR-0027, part 1 of 2): `SemanticQuery` gains `sort` (a list of `{ property, direction }` keys applied in the adapter via a shared `applySort` interpreter) and `select` (projection, applied by the runtime after redaction; requested `include` relationships are still returned). `QueryInclude` also gains `select`. Both fail closed under property-level policy — a sort on a property the caller can't read is denied, and a computed property can't be sorted at the top level — and both are bounded by new `QueryLimits` (`maxSortKeys`, `maxSelect`) and advertised on the MCP `query` tool. Adds the `applySort` / `applyProjection` / `compareForSort` helpers and the `SortKey` type.
