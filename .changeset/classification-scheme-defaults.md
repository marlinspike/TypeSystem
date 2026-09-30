---
"@typesys/core": minor
"@typesys/domain-airforce": minor
---

Classification scheme naming and defaults (ADR-0034). `US_CLASSIFICATION` is renamed `DEMO_LINEAR_CLASSIFICATION` (a demonstration ordering, not the US model), and the runtime's default scheme is now the explicit `DENY_MARKED_DATA`: unmarked data reads as before, marked data is denied until a scheme is configured, so classification can't be disabled by forgetting to configure it. `ClassificationScheme` gains a required `name`, recorded in every classification audit row as `details.scheme`; `linearClassification(levels, name)` returns a scheme that exposes its `levels`. Markings are lists internally (`objectMarkings`, `memberMarkings`, `valueMarkings` replace the single-valued helpers). The airforce testbed now configures `DEMO_LINEAR_CLASSIFICATION` explicitly.
