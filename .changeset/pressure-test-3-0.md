---
"@typesys/core": patch
"@typesys/adapter-http": patch
"@typesys/adapter-postgres": patch
"@typesys/mcp-server": patch
"@typesys/workflow": patch
"@typesys/workflow-postgres": patch
"@typesys/registry-store-postgres": patch
"@typesys/engineer": minor
---

Fixes from the 3.0 pressure test (docs/reviews/3-0-pressure-test.md).
`explainQuery`, `listActions`, described schemas and preview blockers follow
the discovery mode; the HTTP adapter never follows redirects with its
credentials and handles token, cursor and paging edge cases; refusals no
longer trip the circuit breaker; computed provenance names every system
consulted; the Postgres journal stores events holding NUL or lone
surrogates; `audit_events` refuses TRUNCATE; relationship lookups use the
GIN index. Engineer `starts` checks accept `failsAt`, and `query` checks
count every page.
