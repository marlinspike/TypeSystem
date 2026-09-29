---
"@typesys/core": minor
"@typesys/adapter-in-memory": minor
"@typesys/adapter-postgres": minor
"@typesys/adapter-mock-rest": minor
---

Relationship resolution beyond foreign keys (ADR-0028): a shared `parseResolution` turns the terse `operation` string into a typed `ResolutionStrategy`, so adapters stop re-parsing it themselves. Adds many-to-many `byJoinTable:[<dataSourceId>@]<joinType>/<sourceKey>/<targetKey>` and multi-field `byCompositeKey:<targetField>=<sourceField>,...` alongside the existing `byForeignKey` / `byOwnField`, implemented for the in-memory and Postgres adapters (the mock-REST adapter, and any cross-data-source join, throw `UnsupportedResolutionError`). The runtime now caps one-to-many fan-out at the new `QueryLimits.maxRelatedPerObject`, and `QueryInclude` gains `sort` and `limit` for bounded, ordered relationship traversal.
