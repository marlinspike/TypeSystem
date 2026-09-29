---
"@typesys/core": minor
"@typesys/adapter-in-memory": minor
"@typesys/adapter-postgres": minor
"@typesys/mcp-server": minor
---

Query DSL aggregation and full-text search (ADR-0027, part 2 of 2): a new `runtime.aggregate()` (and MCP `aggregate` tool) runs grouped `count`/`sum`/`avg`/`min`/`max` over a Type via the adapter's new optional `aggregate` method — implemented for the in-memory and Postgres adapters; a data source that can't aggregate returns `AggregationNotSupportedError`. `SemanticQuery.search` adds case-insensitive text search, desugaring to a new `icontains` filter operator over the shared `matchesFilter` interpreter — uniform across adapters and fail closed under property policy (it never searches a hidden or computed field, and an explicitly-named hidden property is denied). Adds `computeAggregations`, the `SemanticAggregateQuery` / `AggregateResult` types, and new `QueryLimits` bounds (`maxAggregations`, `maxGroupBy`, `maxSearchTextLength`).
