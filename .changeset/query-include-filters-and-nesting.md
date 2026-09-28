---
"@typesys/core": minor
"@typesys/mcp-server": minor
---

`query` now honors an include entry's own `filter` (applied to the related objects' visible, post-redaction values) and nested `include` (resolved from each related object), as ADR-0011 designed; both were previously accepted and silently ignored. New `QueryLimits.maxIncludeDepth` (default 3). `maxIncludes` now counts include entries across every level, filter limits apply to include-level filters too, and including the same relationship twice at one level is rejected.
