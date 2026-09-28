# 0021. Streamable HTTP Transport for MCP

## Status

Accepted

## Context

`packages/mcp-server` has only ever run over stdio (`bin.ts`,
`StdioServerTransport`) or an in-memory transport pair (the contract
test, the demo web app's MCP Console tab). That's sufficient for a
locally-spawned agent process or an in-process embed, but not for the
increasingly common case of an MCP client — a hosted agent, a browser-
based tool, a teammate's machine — connecting to this server as a
network service. The MCP spec's `2026-07-28` generation (already this
codebase's target, per ADR-0012) defines Streamable HTTP as its
network transport; adding it is the natural next step now that stdio's
one caveat — no standard place to carry a bearer token except embedding
it in-band (a resource URI's `?token=` query string, or a tool call's
`authToken` argument) — has a real answer once HTTP is on the table: the
`Authorization` header.

## Decision

### `StreamableHTTPServerTransport`, stateless, fresh `Server` per request

`packages/mcp-server/src/http-transport.ts` exports `createHttpApp()`
(an Express app) and `startHttpServer(port)`. Every `POST /mcp` request
constructs a **new** `Server` (via the existing `createServer()`) and a
**new** `StreamableHTTPServerTransport({ sessionIdGenerator: undefined
})`, closes both when the response closes, and never persists a
session ID. This is the SDK's own documented pattern for a stateless
Streamable HTTP server, and it is also exactly what ADR-0012 already
required of this codebase for a different reason: identity must be
re-derived on every call, never cached on a connection/session object.
Reusing "one Server per request" that ADR-0012 needed anyway for stdio's
single long-lived connection turns out to be the same shape HTTP's
stateless mode wants, for a different but compatible reason.

All of these per-request `Server` instances share one underlying
`registry`/`runtime` (and therefore one audit log, one cache), built
once — lazily, on first request — rather than per request, so
`http-transport.ts` never re-registers Types or re-seeds sample data on
every call. `GET`/`DELETE /mcp` are rejected with 405, matching the
SDK's own stateless example: those verbs only have meaning in the
stateful (session-resuming) mode this deployment deliberately doesn't
use.

### Identity from a real `Authorization: Bearer <token>` header

`createHttpApp` builds a fresh, per-request `IdentityResolver` that
closes over that request's parsed `Authorization` header and calls
through to the configured base resolver (defaulting to
`resolveDemoIdentity`; pass `@typesys/auth-oidc`'s
`createOidcIdentityResolver(...)` for real verification, unchanged from
how `createServer()` already accepts either). The header takes priority
over an in-band token (a resource URI's `?token=` or a tool call's
`authToken` argument) — a client that only knows the stdio convention
still works if pointed at this transport, but any client that sets a
real `Authorization` header gets the transport-idiomatic behavior HTTP
already has a standard place for.

### One route (`/mcp`), reusing `createServer()` unchanged

No changes were needed to `server.ts`, `resources.ts`, or `tools.ts` —
`createServer(testbed, identityResolver)`'s existing signature is
exactly what a per-request `Server` construction needs. The HTTP
transport is a pure addition alongside `bin.ts` (stdio), not a
replacement or a fork of the resource/tool-handling logic, the same way
`@typesys/auth-oidc` (ADR-0018) plugged into the existing
`identityResolver` parameter without touching either handler file.

## Consequences

- A real network client (`scripts/smoke-test-mcp-http.ts`, verified
  against a real `http.Server`, not a mock) can now reach this MCP
  server exactly the way a hosted agent or browser tool would, with
  identity carried the way HTTP already expects.
- `express` becomes a real dependency of `@typesys/mcp-server` (already
  a dependency of the installed `@modelcontextprotocol/sdk` itself, and
  already used by `@typesys/demo-web`) — not a new kind of dependency
  for this codebase to carry.
- Building one shared testbed lazily inside `createHttpApp` (rather than
  requiring the caller to always pass one) means calling `createHttpApp()`
  with no arguments — the common case — still shares state correctly
  across every request without the caller needing to know that detail.
- No TLS, no CORS policy, no OAuth 2.1/RFC 9396 authorization-server
  integration (only bearer-token *verification*, which
  `@typesys/auth-oidc` already provides) is included here — a real
  internet-facing deployment needs a reverse proxy or gateway in front
  of this for TLS termination and CORS, the same way any Node HTTP
  service does; this ADR is scoped to the MCP transport layer itself.

## Alternatives Considered

- **The legacy HTTP+SSE transport** (two endpoints, `GET` for the SSE
  stream and `POST` for messages, superseded by Streamable HTTP in
  MCP's own spec history): rejected — Streamable HTTP is what the
  `2026-07-28` spec generation this codebase already targets (ADR-0012)
  actually specifies; implementing the older transport would target a
  spec generation this project isn't on.
- **Stateful mode** (`sessionIdGenerator: () => randomUUID()`, session
  IDs, server-initiated `GET` streams): rejected for this pass — nothing
  in this codebase's design needs multi-turn server-initiated streaming
  (no active-notification Actions), and stateful mode would reopen the
  exact "don't cache identity on a session object" risk ADR-0012 spent
  a whole decision closing off for stdio. Stateless mode is the honest
  match for what this server actually needs.
- **A custom raw `http.createServer` handler instead of Express**:
  rejected — Express is already an actual dependency of both the
  installed MCP SDK and this monorepo's demo-web package; introducing a
  second HTTP-handling style for one more route would be inconsistent
  for no benefit.
- **Keeping identity resolution exclusively in-band (query string/tool
  argument), ignoring `Authorization` entirely, for consistency with
  stdio**: rejected — that would ship an HTTP transport that ignores the
  one thing HTTP already has a standard mechanism for, forcing every
  real client into the same workaround stdio needed only because stdio
  has no headers at all.
