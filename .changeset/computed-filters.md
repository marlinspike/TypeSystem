---
"@typesys/core": minor
"@typesys/mcp-server": minor
---

Filtering on computed properties and explainable execution plans (ADR-0054). A `query` filter may name computed properties: those conjuncts run in the runtime on caller-visible values, the rest in the adapter, with pages refilled up to the new `QueryLimits.maxScanned` (default 1000) and an opaque cursor that resumes exactly. `explainQuery` returns `execution`, the steps `query` would take. MCP adds `typesys_explain_query`.
