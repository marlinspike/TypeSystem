---
"@typesys/devkit": minor
"@typesys/core": minor
"@typesys/sdk": minor
"@typesys/mcp-server": minor
"@typesys/cli": minor
---

One model description, discovery, validation and contract diff (ADR-0056). Core adds `describeModel(registry)`. New `@typesys/devkit`: `compactCatalog`, `discover` (ranked, lexical), `validateQuery` (did-you-mean, never-matching conditions), `diffModels` (breaking/risky/compatible, under-versioned Types and Actions). MCP adds `typesys_discover` and `typesys_validate_query`. The CLI adds `describe`, `diff`, `discover` and `check-query`. `generateModel` now takes a `ModelDescription`.
