# TypeS for AI Agents

This page is for an AI agent (or the developer building one) that needs to
read and act on a TypeS-backed domain over MCP. It is procedural, not
architectural — for *why* the system is shaped this way, see
[`why-typesys.md`](why-typesys.md) and
[ADR-0012](adr/0012-mcp-mapping-and-stateless-identity.md).

## The one invariant that matters to you

You can ask for an object, its relationships, its provenance, and the
Actions you're allowed to invoke on it — **without knowing which backend
system produced any of it.** Every one of your calls goes through the same
policy engine and audit log a human application would use. A denial from
this server is a real authorization decision, not a bug to route around.

## Two primitives, not a REST API

MCP's own vocabulary maps directly onto this project's meta-model — there
is nothing TypeS-specific to learn beyond the URI/argument shapes below:

| MCP primitive | What it is here |
|---|---|
| **Resources** (`resources/list`, `resources/read`) | Read-only browsing: Types, objects, relationships, provenance. Never mutates anything. |
| **Tools** (`tools/list`, `tools/call`) | Governed Actions, one MCP tool per registered Action, plus one generic `query` tool. `tools/call` is the only way to change anything. |

The server is **stateless**: every single call resolves your identity
fresh from whatever token you send *on that call*. Nothing is cached
server-side about who you are between calls, so a token that worked a
moment ago and a token that's now denied can both be true in the same
connection — check the result of every call, not just the first one.

## Authentication

**Over HTTP** (see "Running the server" below): send a real
`Authorization: Bearer <token>` header on every request. This is the
authoritative source when present.

**Over stdio** (no headers exist on that transport): the same token goes
in-band instead —

- **Resource reads**: append `?token=<token>` to the URI.
- **Tool calls**: include `"authToken": "<token>"` in the call's
  `arguments`, alongside whatever fields that tool actually needs.

Either way: **no token, or a token the server doesn't recognize** — you're
treated as an anonymous identity with no roles — most reads and every
write will be denied, not erroed. A denial is expected, normal behavior
for the wrong identity, not a sign anything is broken.

This demo server accepts two static demo tokens
(`demo-maintainer-token`, `demo-viewer-token`) — see
`packages/mcp-server/src/auth.ts`. A production deployment replaces only
the token-verification step — `@typesys/auth-oidc`'s real OIDC/JWKS
verification (ADR-0018) drops in behind the exact same `IdentityResolver`
parameter — nothing about how you call the server changes.

## Resource URIs

Scheme is `typesys://`. Every shape you'll ever need:

```
typesys://types                                                  list every registered Type
typesys://types/<typeName>                                       one Type's full definition
typesys://objects/<typeName>/<objectId>?token=...                 one object's resolved properties
typesys://objects/<typeName>/<objectId>/relationships/<relName>?token=...   related objects
typesys://objects/<typeName>/<objectId>/provenance/<propertyPath>?token=... where a property's value came from
```

`<typeName>` is the logical name exactly as registered (e.g.
`airforce.Aircraft`) — get the exact spelling from `typesys://types` or a
Type's own definition before guessing at a relationship or property name.

## Tools

`tools/list` returns one tool per registered Action (its `inputSchema` is
the exact JSON Schema you must satisfy — always includes an `authToken`
string field) plus a generic `query` tool:

```json
{
  "name": "query",
  "arguments": {
    "type": "airforce.Aircraft",
    "filter": { "property": "tailNumber", "operator": "eq", "value": "AF86-0147" },
    "include": [{ "relationship": "components" }],
    "authToken": "demo-maintainer-token"
  }
}
```

`filter` is a `QueryCondition` (`{property, operator, value}`, operators
`eq|ne|gt|gte|lt|lte|in|contains`) or a boolean combinator
(`{and:[...]}` / `{or:[...]}`) — the full shape is
`packages/core/src/model/query.ts`'s `SemanticQuery`.

A denied or failed tool call returns normally (not a protocol error) with
`isError: true` and a human-readable `content[0].text` explaining why —
check `isError` on every `tools/call` result before trusting the payload.

## The discovery sequence a well-behaved agent follows

Don't guess at type names, relationship names, or action names — discover
them:

1. `resources/read` on `typesys://types` → see everything that exists.
2. `resources/read` on `typesys://types/<typeName>` → that Type's
   properties, relationships (names + target types + cardinality),
   `actionNames`, and computed-property names. This is your schema.
3. `resources/read` on `typesys://objects/<typeName>/<objectId>` → the
   actual object. Absent properties you expected to see are not a bug —
   they were likely redacted by a property-level policy your identity
   doesn't satisfy (see the Type definition's `x-policy.propertyPolicies`
   from step 2).
4. `resources/read` on `.../relationships/<relName>` → navigate, using
   relationship names from step 2, never invented ones.
5. `resources/read` on `.../provenance/<propertyPath>` → which source
   system produced a value, when, and at what confidence — use this
   before repeating a value back to a user as fact, especially in a
   regulated or safety-relevant domain.
6. `tools/list` → which Actions exist for the Type you care about, and
   their exact input schemas.
7. `tools/call` → invoke one. Check `isError` first.

## A complete worked example (the shipped demo domain)

```
resources/read  typesys://objects/airforce.Aircraft/AF86-0147?token=demo-maintainer-token
  -> { "typeName": "airforce.Aircraft", "objectId": "AF86-0147",
       "values": { "tailNumber": "AF86-0147", "model": "F-16C",
                    "maintenanceStatus": "degraded", "readinessStatus": "PMC", ... } }

resources/read  typesys://objects/airforce.Aircraft/AF86-0147/relationships/maintenance?token=demo-maintainer-token
  -> [ { "typeName": "airforce.MaintenanceEvent", "objectId": "EVT-9001", "values": {...} }, ... ]

tools/call  CreateMaintenanceWorkOrder
  { "maintenanceEventId": "EVT-9001", "assignedTo": "SSgt Rivera", "authToken": "demo-maintainer-token" }
  -> content[0].text: { "id": "WO-0001", "status": "open", ... }

tools/call  CreateMaintenanceWorkOrder   (same call, wrong identity)
  { "maintenanceEventId": "EVT-9001", "assignedTo": "SSgt Rivera", "authToken": "demo-viewer-token" }
  -> isError: true, content[0].text: "Not authorized: invoke airforce.MaintenanceEvent/CreateMaintenanceWorkOrder"
```

Run this exact sequence yourself: `npm run smoke:mcp` from the repo root
spawns the real server over stdio and executes it end to end
(`scripts/smoke-test-mcp.ts`) — read that file if you want a working
MCP client call, in TypeScript, for every step above.

## Running the server

Stdio (a locally-spawned agent process):

```bash
npm install && npm run build   # from the repo root
node packages/mcp-server/dist/bin.js   # stdio MCP server
```

or, without a build step, `npx tsx packages/mcp-server/src/bin.ts`.

Streamable HTTP (a network client — a hosted agent, a browser tool, a
teammate's machine):

```bash
npm run mcp:http   # http://localhost:3939/mcp, PORT env var to override
```

Both run the identical resource/tool-handling logic against the identical
registry/runtime — see [ADR-0021](adr/0021-http-transport.md) for the
transport-level details (stateless, `Authorization`-header-based
identity, a fresh `Server` per HTTP request). `npm run smoke:mcp-http`
runs the same discover -> act script above end-to-end against a real
`http.Server`.

## If you are building a *new* domain for agents to use

The MCP layer (`packages/mcp-server`) is entirely generic over whatever
the registry holds — adding a domain never touches it. Point it at your
own registry and it already speaks this same protocol correctly. Start at
[`docs/quickstart.md`](quickstart.md) or
[`docs/how-to/add-a-type.md`](how-to/add-a-type.md).
