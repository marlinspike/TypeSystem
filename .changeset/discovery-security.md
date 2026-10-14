---
"@typesys/core": minor
"@typesys/http": minor
"@typesys/mcp-server": minor
---

Discovery is decided by the runtime (ADR-0068). New `SemanticRuntime.describeModel(identity)` and a `discovery` option: `"open"` (default), `"authenticated"` (anonymous callers refused) or `"need-to-know"` (each caller told only the Types, members and Actions they could use, decided by their policies, plans and markings and for their audience). `listActions` follows it. `HIGH_ASSURANCE_V2` adds need-to-know discovery to V1's guarantees. The HTTP API's `/model`, `/openapi.json`, `/discover` and `/query/validate` and MCP's type tools, resources, `resources/list` and `tools/list` describe the model through the runtime. MCP Type documents no longer carry `x-policy`, `x-provenance`, `x-relationships`, `x-computed` or `x-actions`, and `actionNames` now lists every Action applicable to the Type. New `typesys_invoke_action` MCP tool; `buildTypeListUri` and `buildTypeUri` take an optional token.
