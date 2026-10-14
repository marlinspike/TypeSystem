---
"@typesys/http": minor
"@typesys/react": minor
"@typesys/sdk": minor
"@typesys/core": minor
"@typesys/mcp-server": patch
"@typesys/auth-oidc": patch
---

A governed HTTP API and headless React bindings (ADR-0058). New `@typesys/http`: `createApiRouter` and `createApiApp` serve queries, objects, provenance, Actions with preview, aggregate, discovery, query validation, the model and workflows, each as one runtime call for the bearer token's caller; refusals are RFC 9457 problems with a stable `code`; `openApiDocument` generates OpenAPI 3.1 from the model. New `@typesys/react`: `createTypeSysHooks` (typed `useQuery`, `useObject`, `useActions`, `useAction`), `Resource`, `formFields`, `coerceForm` and `columnsFor`. The SDK adds `httpTransport` and `ApiError`. `IdentityResolver` moves to core (re-exported where it was). The MCP server's HTTP transport uses the shared Host and Origin guard.
