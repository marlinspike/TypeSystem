---
"@typesys/core": minor
"@typesys/mcp-server": minor
"@typesys/registry-store-postgres": minor
"@typesys/adapter-mock-rest": minor
"@typesys/domain-airforce": minor
"@typesys/policy-cedar": patch
---

Instance-scoped Actions, Action previews, and Host/Origin checks (ADR-0053). An Action may declare `target: { idFrom }`: the runtime reads that object under the caller's read authorization and decides the Action's policy on its attributes, and preconditions read it through `ctx.getProperty`. `runtime.previewAction(name, input, identity)` decides an invocation without executing it; `listActions` takes an optional `{ objectId }` and reports `instanceScoped`. MCP adds `typesys_list_actions` and `typesys_preview_action`. The HTTP transport answers only `allowedHosts` (default localhost) and browser `allowedOrigins`. Postgres migration `0003_action_target.sql`. The airforce domain adds the instance-scoped `UpdateWorkOrderStatus`; the demo maintainer carries `displayName`.
