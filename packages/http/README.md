# @typesys/http

The governed REST API for TypeSys
([ADR-0058](../../docs/adr/0058-governed-http-api-and-headless-react-bindings.md)).
Every route resolves the caller from the bearer token and makes one runtime
call as them; refusals are RFC 9457 problems with a stable `code`, and the
OpenAPI 3.1 contract is generated from the model.

```ts
import { createApiApp } from "@typesys/http";

const app = createApiApp({ backend: { registry, runtime }, identityResolver, workflows });
app.listen(8080);   // /api/query, /api/objects/:type/:id, /api/actions/:name/preview, /api/openapi.json, ...
```

`GET /api/me` returns the caller the token resolved to. Call it with
`httpTransport` from `@typesys/sdk`. The Host and Origin
guard (`originGuard`) is shared with the MCP server's HTTP transport.

See [`docs/how-to/build-an-app-with-the-api-and-react.md`](../../docs/how-to/build-an-app-with-the-api-and-react.md).
