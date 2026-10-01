---
"@typesys/mcp-server": minor
---

The MCP surface is shaped for tool-first agents (ADR-0051). Each resource read has a tool twin running the same code: `typesys_list_types`, `typesys_describe_type`, `typesys_get_object`, `typesys_get_relationship`, and `typesys_get_provenance`. The `query` and `aggregate` tools are renamed `typesys_query` and `typesys_aggregate`; the old names are still accepted on call, but no longer listed, until the next minor version. Every TypeS tool returns `structuredContent` and declares an `outputSchema`. Action tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derived from the Action's `sideEffects` and `idempotency`. The `typesys_` prefix is reserved: `tools/list` fails if the registry holds an Action named with it. New exports: `actionAnnotations` and `RESERVED_TOOL_PREFIX`.
