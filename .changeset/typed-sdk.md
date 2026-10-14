---
"@typesys/sdk": minor
"@typesys/core": minor
"@typesys/cli": minor
"@typesys/mcp-server": patch
"@typesys/registry-store-postgres": minor
"@typesys/domain-airforce": minor
"@typesys/domain-hospital": minor
---

A typed SDK generated from the registry (ADR-0055). New `@typesys/sdk`: `generateModel(registry)` emits a model interface; `createClient<Model>(transport)` gives typed queries (filters on stored and computed properties, includes, projections, paging, explain), reads, provenance and Actions over `runtimeTransport` or `mcpTransport`. Computed properties may declare a value `schema`, which the registry compiles and the runtime enforces (`ComputedValueError`). `typesys generate-sdk [--check]`. The demo domains export their generated `AirforceModel` and `HospitalModel`.
