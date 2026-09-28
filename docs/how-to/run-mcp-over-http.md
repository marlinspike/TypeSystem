# How to run the MCP server over HTTP

For a network client — a hosted agent, a browser-based tool, a
teammate's machine — instead of a locally-spawned stdio process (see
[ADR-0021](../adr/0021-http-transport.md)).

## Run it

```bash
npm run mcp:http   # http://localhost:3939/mcp — PORT env var to override
```

or embed it in your own process:

```ts
import { createHttpApp } from "@typesys/mcp-server";

const app = createHttpApp(); // Express app — mount it, add middleware, whatever you need
app.listen(8080);
```

## Authenticate with a real header

```bash
curl -X POST http://localhost:3939/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer demo-maintainer-token" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `Authorization` header is the authoritative identity source over
HTTP — no need to embed a token in a resource URI's `?token=` query
string or a tool call's `authToken` argument (that in-band convention
only exists because stdio has no headers at all; it still works as a
fallback here for clients that only know it).

## Use a real `IdentityResolver`

```ts
import { createHttpApp } from "@typesys/mcp-server";
import { createOidcIdentityResolver } from "@typesys/auth-oidc";

const app = createHttpApp({
  identityResolver: createOidcIdentityResolver({ issuer: "https://your-idp.example.com", audience: "typesys-mcp" })
});
```

Same drop-in swap `createServer()` already supported (ADR-0018) — the
HTTP transport doesn't add a second auth mechanism to configure.

## What it is, precisely

`StreamableHTTPServerTransport` in **stateless** mode
(`sessionIdGenerator: undefined`) — one endpoint (`POST /mcp`), a fresh
`Server`+transport per request, no session ID, `GET`/`DELETE /mcp`
rejected with 405 (they only have meaning in the stateful mode this
deployment doesn't use). Every request shares one underlying
registry/runtime (built once, lazily, on first request) — so state
(the audit log, anything cached) is consistent across requests, only
the MCP-protocol-level `Server` object is per-request.

Not included: TLS termination, CORS, or an OAuth 2.1 authorization
server — put a reverse proxy or gateway in front of this for an
internet-facing deployment, the same as any Node HTTP service.

## Verify it

```bash
npm run smoke:mcp-http
```

Runs the same discover -> inspect -> retrieve -> navigate -> provenance
-> list-actions -> invoke script as `npm run smoke:mcp`, but against a
real `http.Server` with identity carried in a real `Authorization`
header — see
[`scripts/smoke-test-mcp-http.ts`](../../scripts/smoke-test-mcp-http.ts).
