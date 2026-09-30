---
"@typesys/mcp-server": minor
"@typesys/domain-airforce": minor
---

The MCP server serves any registry (ADR-0050). `createServer(backend, resolveIdentity, info?)` and `createHttpApp({ backend, identityResolver, serverInfo? })` / `startHttpServer(port, options)` now take any `{ registry, runtime }` (what `buildRuntime` returns) and a required identity resolver, and throw at construction without either; they no longer build the airforce demo or fall back to its demo tokens, and `createServer` is synchronous. `resources/list` lists Types only — the hardcoded `airforce.Aircraft/AF86-0147` resource is gone. `@typesys/mcp-server` no longer depends on `@typesys/domain-airforce` or ships `typesys-mcp-server` binaries; the demo's stdio and HTTP entry points moved to `@typesys/demo-web`. `@typesys/domain-airforce` gains `resolveDemoIdentity`, the demo's static token map, as an own-property lookup (`constructor` and `__proto__` are not tokens).
