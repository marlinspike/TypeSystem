---
"@typesys/core": minor
---

`maxConcurrency` is now one budget per top-level runtime call: nested fan-out (query items, include trees, relationships, and computed properties' own `ctx.getAdapter` calls) draws from the same permits instead of multiplying the cap per level. A top-level `query` filter on a computed property is now rejected with `InvalidInputError` (it previously matched nothing, since the adapter filters before computed values exist); include-level filters on computed properties work. Re-registering an Action's same version with a changed `inputSchema` now takes effect for input validation instead of keeping the old compiled schema.
