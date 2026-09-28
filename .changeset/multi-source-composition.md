---
"@typesys/core": minor
"@typesys/domain-airforce": minor
---

Add multi-source property composition: `getObject`/`query` now merge a Type's base wildcard `Mapping` with per-property overrides from other DataSources into one object read (ADR-0023). Add `Aircraft.needsAttention`, a real cross-source computed property proving `ComputeContext.getAdapter()` can combine data from two different adapters into one derived value (ADR-0022).
