---
"@typesys/mcp-server": minor
"@typesys/adapter-in-memory": minor
---

Add a stateless Streamable HTTP transport for the MCP server (`createHttpApp`/`bin-http.ts`, ADR-0021), with identity resolved from a real `Authorization: Bearer` header. Add `"byOwnField:<field>"` relationship resolution to `InMemoryRepositoryAdapter`, needed by the new `@typesys/domain-hospital` package's one-to-one relationships.
