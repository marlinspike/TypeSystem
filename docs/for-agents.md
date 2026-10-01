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
| **Tools** (`tools/list`, `tools/call`) | One tool per registered Action, plus seven read-only tools TypeS provides: `typesys_list_types`, `typesys_describe_type`, `typesys_get_object`, `typesys_get_relationship`, `typesys_get_provenance`, `typesys_query`, and `typesys_aggregate`. Calling an Action's tool is the only way to change anything. |

**If your framework uses only tools, you lose nothing.** Each resource read
has a tool twin that runs the same code, so it returns the same value and
the same refusal and writes the same audit rows (ADR-0051).

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

The demo server in this repository accepts two static demo tokens
(`demo-maintainer-token`, `demo-viewer-token`) — see `resolveDemoIdentity`
in `packages/domain-airforce/src/setup.ts`. A server built on
`@typesys/mcp-server` always gets its resolver from whoever builds it
(ADR-0050). A production deployment replaces only
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
string field) plus TypeS's own tools, all named `typesys_…` (no Action may
use that prefix):

| Tool | Arguments | Returns (`structuredContent`) |
|---|---|---|
| `typesys_list_types` | none | `{ "types": [...] }`: every Type's definition, as `typesys://types` gives them. |
| `typesys_describe_type` | `type` | The Type's definition, as `typesys://types/<type>` gives it. |
| `typesys_get_object` | `type`, `id` | The object with each value's provenance, as `typesys://objects/<type>/<id>`. |
| `typesys_get_relationship` | `type`, `id`, `relationship` | `{ "objects": [...] }`: the related objects you may read. |
| `typesys_get_provenance` | `type`, `id`, `property` | `{ "provenance": [...] }`: where the value came from. |
| `typesys_query` | the query DSL below | `{ "items": [...], "nextCursor"? }` |
| `typesys_aggregate` | `type`, `filter`?, `groupBy`?, `aggregations` | `{ "groups": [{ "key", "values" }] }` |

Every one returns `structuredContent`, validated by your MCP client against
the tool's `outputSchema`, and the same JSON as text in `content[0].text`.
`query` and `aggregate` still answer to their old unprefixed names for one
minor version, but are no longer listed under them.

**Annotations say what an Action does.** Each Action's tool carries MCP
annotations taken from its definition: `readOnlyHint` when it has no side
effects, `destructiveHint` when it mutates existing data or calls an
external system, `idempotentHint` when repeating it changes nothing more,
and `openWorldHint` when it reaches outside the registry's systems. TypeS's
own tools are all read-only. Use them to decide what needs a human's
confirmation. They are hints: whether you may invoke an Action is still
decided by the server on every call.

```json
{
  "name": "typesys_query",
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

**The `typesys_query` tool's `inputSchema` from `tools/list` is the exact schema
the server enforces**, limits included — read it rather than relying on
the defaults below, since a deployment can change them:

| Bound | Default | What happens past it |
|---|---|---|
| `limit` | 100 when omitted, max 1000, integer ≥ 1 | Rejected, not clamped. |
| `include` entries, all levels counted | 10 | Rejected. |
| `include` nesting depth | 3 | Rejected. |
| Any one `filter`'s nesting (`and`/`or` depth), top-level or include-level | 8 | Rejected. |
| Any one `filter`'s leaf conditions | 100 | Rejected. |

- **Results are paged.** A query without `limit` returns at most 100
  items. If the result has a `nextCursor`, pass it back as `cursor` (with
  the same `type`/`filter`) for the next page. Its absence means you have
  everything.
- **Results contain only what you may read.** Read access is decided per
  object, on that object's own data (a clinician reads only their own
  patients), and objects you can't read are silently left out. Where the
  read rule can be turned into a filter the store applies (an exact
  authorization plan, ADR-0038), pages come back full; otherwise a page can
  be shorter than `limit`, or even empty, and still carry a `nextCursor` —
  keep following it. An empty result can therefore mean "nothing matches"
  or "nothing you may read matches"; you can't tell which, by design. What
  you *can* tell is a refusal: if your identity can read no object of the
  Type at all — its role doesn't qualify, or the Type is classified above
  your clearance — the call fails with `Not authorized: read <Type>`
  (ADR-0049), so a refusal is not an empty result and "there are none" is
  not the conclusion to draw. A deployment that requires exact plans also
  refuses a query whose rule can't be planned exactly (`Refused under …`,
  below). Properties
  can also be absent because they are classified above your identity's
  clearance; filtering or sorting on one is refused with `Not authorized:`.
- **Unknown fields are rejected**, at the top level and inside filters and
  includes. A typo like `"operater"` fails the call; it isn't silently
  ignored. `authToken` is the one extra field every tool accepts.
- **Includes can filter and nest.** Each include entry takes its own
  `filter` (applied to that relationship's related objects) and its own
  `include` (resolved from each related object that survives the filter),
  e.g. `{"relationship": "maintenance", "filter": {"property":
  "eventType", "operator": "eq", "value": "unscheduled"}, "include":
  [{"relationship": "workOrder"}]}`. Results nest the same way, keyed by
  relationship name, so don't list the same relationship twice at one
  level.
- **Filter only on properties you can read.** A top-level `filter` that
  references a property your identity can't see (one missing from the
  objects you get back) is rejected with `Not authorized`, since answering
  it would reveal the hidden value. Include filters run after redaction
  instead, so a condition on a property you can't read behaves as if the
  property were absent.

**Action tools validate their input too.** Arguments (minus `authToken`)
are checked against that Action's `inputSchema` *after* the authorization
check, so an identity that isn't allowed to invoke the Action gets the
denial, not a schema complaint.

A denied or failed tool call returns normally (not a protocol error) with
`isError: true` and a human-readable `content[0].text` explaining why —
check `isError` on every `tools/call` result before trusting the payload.
The text tells you which kind of failure it was:

| `content[0].text` starts with | Meaning | What to do |
|---|---|---|
| `Not authorized:` | Policy denied this identity: a query of a Type it can read none of, an Action, or filtering on a property it can't read (the message names the property). | Don't retry with the same token; drop the hidden property from the filter, or accept the denial. |
| `Invalid query:` / `Invalid input for action` | Your arguments failed the schema or a limit, or a top-level filter used a computed property; the message names the problem. | Fix the arguments and retry. For a computed property, filter on it inside an include, or filter the results yourself. |
| `Precondition failed` | The input was well-formed but a business rule rejected it (e.g. the referenced object doesn't exist). | Check the referenced data. |
| `Cannot … encrypted field` | The field is stored encrypted, so the store can't range-filter, sort, search, aggregate, or join on it; the message says what does work. | Drop that part of the query, or name `search.properties` without the field. |
| `Refused under` | The deployment requires exact authorization plans (`rowSecurity: "require-exact"` or the `HIGH_ASSURANCE_V1` profile, ADR-0038/0046), and this query's — or this aggregate's — couldn't be guaranteed. The message names the policy and why, never a value. | Not a transient error: don't retry the same query. Read objects one at a time with `typesys_get_object`, or ask an operator. |
| `Rate limit exceeded` | Too many calls for this identity. | Back off and retry later. |
| `Not found:` / `Unknown type` | The object or Type doesn't exist, and (for an object) you may read the Type's objects. | Check the id or name against `typesys_describe_type` or a query. |
| `typesys_… must be a non-empty string` | A read tool was called without an argument it needs. | Supply it. |

## The discovery sequence a well-behaved agent follows

Don't guess at type names, relationship names, or action names — discover
them. Each read below has a tool twin, given in brackets, if you'd rather
use tools only:

1. `resources/read` on `typesys://types` (`typesys_list_types`) → see everything that exists.
2. `resources/read` on `typesys://types/<typeName>` (`typesys_describe_type`) → that Type's
   properties, relationships (names + target types + cardinality),
   `actionNames`, and computed-property names. This is your schema.
3. `resources/read` on `typesys://objects/<typeName>/<objectId>` (`typesys_get_object`) → the
   actual object. Absent properties you expected to see are not a bug —
   they were likely redacted by a property-level policy your identity
   doesn't satisfy (see the Type definition's `x-policy.propertyPolicies`
   from step 2). An object that doesn't exist fails the read with
   `Not found: <typeName>/<objectId>`, not an empty object. You get that
   only where your identity may read the Type's objects; otherwise it is
   `Not authorized:` whether or not the id exists, so a refusal tells you
   nothing about an id.
4. `resources/read` on `.../relationships/<relName>` (`typesys_get_relationship`) → navigate, using
   relationship names from step 2, never invented ones. A related object
   you may not read, or one the source system no longer holds, is left out
   of the list.
5. `resources/read` on `.../provenance/<propertyPath>` (`typesys_get_provenance`) → which source
   system produced a value, when, and at what confidence — use this
   before repeating a value back to a user as fact, especially in a
   regulated or safety-relevant domain.
6. `tools/list` → which Actions exist for the Type you care about, their
   exact input schemas, and their annotations.
7. `tools/call` → invoke one. Check `isError` first, and confirm with a
   human before an Action whose `destructiveHint` is true.

## A complete worked example (the shipped demo domain)

```
resources/read  typesys://objects/airforce.Aircraft/AF86-0147?token=demo-maintainer-token
  -> { "typeName": "airforce.Aircraft", "objectId": "AF86-0147",
       "values": { "tailNumber": "AF86-0147", "model": "F-16C",
                    "maintenanceStatus": "degraded", "readinessStatus": "PMC",
                    "needsAttention": true, ... } }
  # readinessStatus and needsAttention are both computed — the first from
  # this Aircraft's own maintenanceStatus, the second also from a live
  # cross-source check against the maintenance system's WorkOrders (see
  # ADR-0022 and docs/how-to/combine-multiple-sources.md) — neither is
  # stored anywhere; both are derived fresh on every read.

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
node packages/demo-web/dist/mcp-stdio.js   # stdio MCP server
```

or, without a build step, `npx tsx packages/demo-web/src/mcp-stdio.ts`. These
are the demo's entry points (the airforce domain and its demo tokens); your
own project builds its server with `createServer(backend, resolveIdentity)`,
as [`start-a-project.md`](how-to/start-a-project.md) shows.

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
the registry holds — adding a domain never touches it. Give
`createServer(backend, resolveIdentity)` your own registry and runtime and
it speaks this same protocol correctly (ADR-0050). Start at
[`docs/quickstart.md`](quickstart.md) or
[`docs/how-to/add-a-type.md`](how-to/add-a-type.md).
