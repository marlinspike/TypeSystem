---
"@typesys/core": minor
"@typesys/mcp-server": minor
---

Validate caller input at the `SemanticRuntime` boundary. `query` now checks its input against `semanticQuerySchema` and `QueryLimits` (`defaultLimit` 100, `maxLimit` 1000, `maxIncludes` 10, `maxFilterDepth` 8, `maxFilterConditions` 100; override via the new `SemanticRuntime` constructor argument or `buildRuntime({ queryLimits })`), and `invokeAction` checks input against the Action's `inputSchema` after the policy check. Failures throw the new `InvalidInputError`. **Behavior change:** a query that omits `limit` now returns at most `defaultLimit` items (follow `nextCursor`) instead of every match. The MCP `query` tool now advertises the full enforced schema, limits included.
