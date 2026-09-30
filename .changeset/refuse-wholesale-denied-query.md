---
"@typesys/core": minor
---

A query the caller can read none of is refused (ADR-0049). `SemanticRuntime.query` now throws `AuthorizationError` — instead of returning an empty page — when the read policy's plan is `never` for the caller, or the Type's classification is above the caller's clearance. Both hold for every possible dataset, so the refusal reveals nothing about the data; a denied row is still dropped silently, because an error there would reveal that hidden rows exist. A rule that cannot plan (a plain function) still gives an empty page. Breaking for a caller that treated an empty page as "no access"; the MCP `query` tool now reports the refusal as `isError` rather than an empty result.
