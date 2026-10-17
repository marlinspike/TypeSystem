# TypeSystem

[![CI](https://github.com/marlinspike/TypeSystem/actions/workflows/ci.yml/badge.svg)](https://github.com/marlinspike/TypeSystem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeSystem (TypeSys for short) is a TypeScript library and server that sits
between the programs that use your data (applications, workflows, AI agents)
and the systems that hold it (databases, REST APIs, other services). You
describe your business objects once, say where each part of them is stored,
and write down who may see and change what. From then on every caller asks
TypeSys for objects instead of querying the stores, and TypeSys:

- reads each part of the object from whichever store holds it and joins them
  into one object;
- removes whatever this caller may not see: whole objects, single fields, and
  fields above the caller's clearance;
- records, for every value, which system and record it came from;
- lets the caller change data only through named Actions, each with its own
  permission check, input schema and preconditions;
- writes an audit record for every decision, allowed or refused.

Because all of this happens in one place, a React app, a REST client and an
AI agent connected over MCP get the same answer for the same person, and none
of them has to re-implement the access rules.

## Where it sits in a system

```mermaid
flowchart TB
    subgraph callers["Callers"]
        web["Web or mobile app<br/>(@typesys/sdk, @typesys/react)"]
        svc["Other services<br/>(REST: @typesys/http)"]
        agent["AI agent<br/>(MCP: @typesys/mcp-server)"]
        wf["Long-running processes<br/>(@typesys/workflow)"]
    end
    subgraph ts["TypeSys process"]
        rt["SemanticRuntime<br/>getObject · query · aggregate · invokeAction"]
        reg["Registry: Types, relationships,<br/>Actions, data sources, mappings"]
        pol["Policy engine (ABAC or Cedar)<br/>+ classification"]
    end
    subgraph stores["Systems of record (unchanged)"]
        pg[("PostgreSQL")]
        rest[("Existing REST API")]
        http[("Other HTTP services")]
        mem[("In-memory / your own adapter")]
    end
    meta[("PostgreSQL: registry tables,<br/>audit_events, workflow journal")]
    web --> rt
    svc --> rt
    agent --> rt
    wf --> rt
    rt --- reg
    rt --- pol
    rt -->|adapter| pg
    rt -->|adapter| rest
    rt -->|adapter| http
    rt -->|adapter| mem
    reg --- meta
```

TypeSys does not replace your databases. Your systems of record stay where
they are; TypeSys reads from them (and writes to them through Actions) on every
request. What it stores itself is the model, the mappings and the audit log.
Two optional parts also hold copies of business data, which matters if you are
deciding data residency or accreditation: the Redis cache (when you enable it)
keeps adapter output and computed values as plaintext JSON until they expire,
and the workflow journal keeps each step's inputs and outputs for as long as
the run's history is kept.

You run it either as a library inside your Node service
(`new SemanticRuntime(...)`) or as a server that exposes it over REST
(`createApiApp`) and MCP (`npm run mcp:http`). Callers never get a database
connection.

## What a read returns

The airforce example domain spreads one aircraft across two systems: its own
fields live in a fleet repository, and its maintenance history lives in a
separate maintenance system reached over REST. Reading tail number
`AF86-0147`:

```ts
const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer, { includeProvenance: true });
```

As the maintainer (role `maintainer`, cleared SECRET):

```json
{
  "id": "AF86-0147", "tailNumber": "AF86-0147", "model": "F-16C",
  "maintenanceStatus": "degraded",
  "deploymentLocation": "FOB ALPHA (exercise designation)",
  "readinessStatus": "PMC",
  "needsAttention": true,
  "...": "..."
}
```

As the viewer (role `viewer`, cleared CUI), the same call returns the same
object without `maintenanceStatus` (a property policy allows it to maintainers
only), without `readinessStatus` (computed from `maintenanceStatus`, so it
inherits that restriction), and without `deploymentLocation` (marked SECRET).
`needsAttention` stays, because the model explicitly releases that one yes/no
flag to every reader. Anonymous callers get `Not authorized: read
airforce.Aircraft/AF86-0147`.

With `includeProvenance`, each value carries where it came from:

```json
{ "propertyPath": "maintenanceStatus",
  "source": { "dataSourceId": "in-memory-airforce-repo", "system": "airforce-repo", "recordId": "AF86-0147", "field": "maintenanceStatus" },
  "retrievedAt": "2026-10-14T09:05:57.987Z", "confidence": 1 }
```

`needsAttention` is a computed property. Its code reads `maintenanceStatus`
and, if that alone doesn't decide it, asks the maintenance system for open
work orders against this aircraft. `getProvenance` traces it back to the
values it was derived from.

The model that produces this is ordinary JSON Schema with a few annotations
([`packages/domain-airforce/src/types/aircraft.ts`](packages/domain-airforce/src/types/aircraft.ts)):

```ts
properties: { tailNumber: { type: "string" }, model: { type: "string" }, deploymentLocation: { type: "string" } },
"x-relationships": {
  components:  { target: "airforce.Component",        cardinality: "one-to-many",
                 resolution: { dataSourceId: "in-memory-airforce-repo", operation: "byForeignKey:aircraftId" } },
  maintenance: { target: "airforce.MaintenanceEvent", cardinality: "one-to-many",
                 resolution: { dataSourceId: "mock-remis-rest",       operation: "byForeignKey:aircraftId" } }
},
"x-computed": { needsAttention: { dependsOn: ["maintenanceStatus"], releases: ["maintenanceStatus"],
                                  binding: "computeNeedsAttention", schema: { type: "boolean" } } },
"x-policy":   { objectPolicy: "airforce.read-aircraft", propertyPolicies: { maintenanceStatus: "airforce.maintainer-only" } },
"x-provenance": { properties: { deploymentLocation: { classification: "SECRET" } } }
```

## How data is stored and loaded

### What lives where

| Data | Where it lives | Package |
|---|---|---|
| Your business data | In your existing systems, reached through an **adapter** per system | `adapter-postgres`, `adapter-http`, `adapter-mock-rest`, `adapter-in-memory`, or your own |
| The model: Types, relationships, Actions, data sources, mappings | Registry tables `types`, `relationships`, `actions`, `data_sources`, `mappings` | `registry-store-postgres` (or in memory for tests) |
| The audit log | Table `audit_events`; update and delete are blocked by a trigger | `registry-store-postgres` |
| Workflow runs, approvals and timers, including each step's inputs and outputs | Tables `typesys_workflow_runs` and `typesys_workflow_events`; events are append-only, enforced by triggers | `workflow-postgres` |
| Optional cache and rate limits shared across instances; the cache holds copies of adapter output and computed values until they expire | Redis | `redis` |

An **adapter** is the only code that talks to a store. It implements one
small interface ([`packages/core/src/runtime/adapter.ts`](packages/core/src/runtime/adapter.ts)):

```ts
interface Adapter {
  readonly dataSourceId: string;
  resolveProperties(typeName, objectId, propertyNames): Promise<{ values, provenance }>;
  queryByType(typeName, filter?, limit?, cursor?, sort?): Promise<{ items, nextCursor? }>;
  resolveRelationship(relationship, sourceObjectId): Promise<{ objectId }[]>;
  executeAction(action, input, ctx): Promise<unknown>;
  aggregate?(query): Promise<AggregateResult>;          // optional
  canFilter?(typeName, property, operator): boolean;    // optional: what it can filter in the store
}
```

A **mapping** connects a Type to an adapter. `targetName: "*"` means "all of
this Type's properties come from this data source"; a mapping for one property
overrides it, so one object can be assembled from several stores.

### The Postgres adapter's storage

`@typesys/adapter-postgres` is generic: it keeps every object of every Type
as one JSON row, so a new Type needs no migration.

```sql
CREATE TABLE objects (
  type_name  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  values     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (type_name, object_id)
);
CREATE INDEX idx_objects_values ON objects USING GIN (values);
```

Loading one object is `SELECT values FROM objects WHERE type_name = $1 AND
object_id = $2`. A query's filter is compiled to a parameterized `WHERE` over
the JSONB column, using the GIN index for equality, and every row that comes
back is checked again in TypeScript, so a filter SQL can only approximate
never lets through a row it shouldn't. A relationship such as
`byForeignKey:aircraftId` becomes `WHERE type_name = $1 AND values @> '{"aircraftId": "AF86-0147"}'`,
a containment test the same GIN index serves.

For a high-volume Type with its own table and columns, write an adapter for
that table; nothing above the adapter changes. To put a TypeSys model over an
existing service you don't own, `@typesys/adapter-http` maps JSON fields to
properties with JSON Pointers and supports API keys and OAuth client
credentials.

### The read path

What `runtime.getObject(type, id, identity)` does, in order
([`packages/core/src/runtime/runtime.ts`](packages/core/src/runtime/runtime.ts)):

1. Check the caller's rate limit, and that their clearance covers the
   Type's markings.
2. Find the Type's mappings and call each adapter's `resolveProperties`
   (concurrently, under a per-request concurrency budget, with a timeout,
   retries and a circuit breaker per call). Per-property overrides from other
   stores are merged in.
3. Decide the Type's object policy on the stored values. This is how
   row-level rules work: "a clinician reads only patients assigned to them"
   is decided on each record's own fields.
4. Run the Type's computed properties, each over only the inputs its
   `dependsOn` names.
5. Remove properties whose classification is above the caller's clearance,
   then properties whose own policy refuses this caller. A computed value goes
   too when any input it was derived from is withheld, unless the model
   `releases` that input for it.
6. Attach provenance if asked (a computed value's provenance names its inputs
   and every system its code consulted), write the audit rows, and return.

`runtime.query` does the same for many objects. Before reading, it turns the
caller's read policy into a filter and pushes it into the adapter's query
where the adapter says it can evaluate that filter exactly, so Postgres never
returns rows the caller could not read anyway. Every returned object is still
decided on its own data.

### The write path

Callers never write to a store directly. They invoke an **Action**, a named
operation with an input schema, a permission rule, optional preconditions and
a declared side effect. `runtime.invokeAction(name, input, identity)`:

1. checks the Action's permission rule, on the target object's own data when
   the Action acts on one object (a refusal is audited);
2. validates the input against its JSON Schema;
3. runs each precondition (for example "a closed work order cannot change
   status");
4. calls `executeAction` on the adapter named in the Action's
   `implementation`, which performs the write in the store;
5. evicts the target from the cache and, when the Action is marked
   `auditRequired`, writes a success row to the audit log.

The generic Postgres, HTTP and in-memory adapters implement no Actions: what a
write means is specific to your data, so you write that part. The example
below does it in a dozen lines. `PostgresRepositoryAdapter.put()` exists for
loading data and for your Action code to call; it is not exposed to callers.

## A complete example on PostgreSQL

A `fleet.Truck` Type stored in Postgres, readable by dispatchers and
mechanics, whose `driverNotes` only mechanics see, and whose status only a
mechanic may change. This was run against PostgreSQL 16 while writing this
README.

```ts
import { buildRuntime, requireRole, type ActionDefinition, type Identity } from "@typesys/core";
import { createPool, runMigrations as migrateRegistry, PostgresRegistryStore } from "@typesys/registry-store-postgres";
import { runMigrations as migrateObjects, PostgresRepositoryAdapter } from "@typesys/adapter-postgres";
import { createApiApp } from "@typesys/http";

const pool = createPool();          // DATABASE_URL
await migrateRegistry(pool);        // model tables + audit_events
await migrateObjects(pool);         // objects table

// Reads come from the generic adapter. Writes are yours: an Action names an
// operation, and the adapter for its data source carries it out.
class FleetStore extends PostgresRepositoryAdapter {
  override async executeAction(action: ActionDefinition, input: unknown): Promise<unknown> {
    if (action.implementation.operation !== "setStatus") throw new Error(`no operation ${action.implementation.operation}`);
    const { truckId, status } = input as { truckId: string; status: string };
    const { values } = await this.resolveProperties("fleet.Truck", truckId, []);
    const next = { ...values, status };
    await this.put("fleet.Truck", truckId, next);
    return next;
  }
}
const fleet = new FleetStore(pool, "fleet-db", "Fleet database");
await fleet.put("fleet.Truck", "T-100", { id: "T-100", plate: "7ABC123", status: "in-service", driverNotes: "brakes soft" });

const { registry, runtime } = await buildRuntime({
  store: new PostgresRegistryStore(pool),
  manifests: [],
  adapters: [fleet],
  policyRules: {
    "fleet.staff": requireRole("dispatcher", "mechanic"),
    "fleet.mechanic": requireRole("mechanic")
  }
});

await registry.registerDataSource({ id: "fleet-db", name: "Fleet database", kind: "postgres" });
await registry.registerType(
  {
    $id: "https://example.com/types/fleet/Truck/1.0.0",
    title: "Truck",
    type: "object",
    properties: { id: { type: "string" }, plate: { type: "string" }, status: { type: "string" }, driverNotes: { type: "string" } },
    "x-policy": { objectPolicy: "fleet.staff", propertyPolicies: { driverNotes: "fleet.mechanic" } }
  },
  { name: "fleet.Truck", version: "1.0.0" }
);
await registry.registerMapping({
  id: "map-truck", typeName: "fleet.Truck", target: "property", targetName: "*",
  dataSourceId: "fleet-db", operation: "get", resolutionMode: "live"
});
await registry.registerAction({
  id: "action-set-truck-status", name: "SetTruckStatus", version: "1.0.0",
  description: "Take a truck in or out of service.",
  applicableTypes: ["fleet.Truck"], target: { idFrom: "truckId" },
  inputSchema: {
    type: "object",
    properties: { truckId: { type: "string" }, status: { enum: ["in-service", "out-of-service"] } },
    required: ["truckId", "status"], additionalProperties: false
  },
  outputSchema: { type: "object" },
  authorizationPolicy: "fleet.mechanic",
  implementation: { dataSourceId: "fleet-db", operation: "setStatus" },
  sideEffects: "mutates", idempotency: "natural", auditRequired: true
});

const dispatcher: Identity = { subjectId: "dana", roles: ["dispatcher"], attributes: {} };
const mechanic: Identity = { subjectId: "mo", roles: ["mechanic"], attributes: {} };

await runtime.getObject("fleet.Truck", "T-100", dispatcher);
// { typeName: "fleet.Truck", objectId: "T-100",
//   values: { id: "T-100", plate: "7ABC123", status: "in-service" } }   driverNotes withheld

await runtime.invokeAction("SetTruckStatus", { truckId: "T-100", status: "out-of-service" }, mechanic);
try {
  await runtime.invokeAction("SetTruckStatus", { truckId: "T-100", status: "in-service" }, dispatcher);
} catch (err) {
  console.log(String(err)); // AuthorizationError: Not authorized: invoke fleet.Truck/SetTruckStatus
}

const tokens: Record<string, Identity> = { "dana-token": dispatcher, "mo-token": mechanic };
createApiApp({
  backend: { registry, runtime },
  identityResolver: async (token) => tokens[token ?? ""] ?? { subjectId: "anonymous", roles: [], attributes: {} }
}).listen(8080);
```

Afterwards the database holds the model in the registry tables, one row in
`objects` with `status: "out-of-service"`, and in `audit_events` a row for
each decision: Dana's read, Mo's allowed `SetTruckStatus` and its success, and
Dana's refused `SetTruckStatus`. `curl -H "Authorization: Bearer mo-token"
localhost:8080/api/objects/fleet.Truck/T-100` returns the truck with
`driverNotes`; with `dana-token` it returns it without.

In production the identity resolver is `createOidcIdentityResolver` from
`@typesys/auth-oidc`, which verifies a JWT against your identity provider. The
API never assumes an identity of its own.

## What callers use

| Caller | Package | What it gets |
|---|---|---|
| TypeScript code in the same process | `@typesys/core` | `getObject`, `query`, `aggregate`, `getProvenance`, `listActions`, `previewAction`, `invokeAction`, `describeModel` |
| A typed client | `@typesys/sdk` | `af.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).page()`, checked by the compiler, over the runtime, REST or MCP |
| A React app | `@typesys/react` | Hooks over the SDK; form fields and table columns derived from the model |
| Any HTTP client | `@typesys/http` | `GET /api/objects/:type/:id`, `POST /api/query`, `POST /api/actions/:name/invoke`, workflow routes, an OpenAPI document; errors as RFC 9457 problems |
| An AI agent | `@typesys/mcp-server` | MCP tools `typesys_discover`, `typesys_get_object`, `typesys_query`, `typesys_get_provenance`, `typesys_list_actions`, `typesys_preview_action`, `typesys_invoke_action` and others, plus one tool per Action the caller may invoke |
| A multi-step process with approvals | `@typesys/workflow` | Steps that read, compute, ask a model, wait for a person's approval and invoke Actions, each as the person who started it; the journal survives restarts |
| A whole application, from a spec | `@typesys/compiler` | `typesys app check, compile, build, verify` and the same as `typesys_app_*` MCP tools: an `app.json` of reads, expressions, workflow steps, interface nodes and effects, type-checked against the model, compiled to TypeScript and React over the SDK, and verified through its API and in Chromium ([`docs/roadmap-4.md`](docs/roadmap-4.md)) |

An agent connected over MCP is just another caller with an identity. It sees
only what that identity may see and can change only what that identity may
change. A model can also be given an *audience* of its own, so policy can
decide what may be sent to that model regardless of who is asking
([ADR-0067](docs/adr/0067-release-to-models-is-decided-for-the-model.md)).

## Why use it

- **The rules are written once.** Without it, every application and every
  agent integration re-implements "who may see this field" and drifts. Here
  the rule lives in the model and the runtime enforces it for every caller.
- **One object across several systems.** An aircraft whose data is split
  between a fleet database and a maintenance system is read as one object,
  without building a data warehouse or a sync job.
- **Agents get governed access, not credentials.** An agent never holds a
  database password or an API key to a back-end system. It holds a token for
  a person or a model audience, and everything it does is audited under that.
- **Every value can be traced.** Provenance says which system and record a
  value came from, which matters when a decision is questioned later.
- **Writes are explicit.** The only changes possible are the Actions in the
  model, each with a permission check, input validation and preconditions.

**When not to use it:** one application over one database, with simple access
rules. TypeSys adds a layer, a model to maintain and a few milliseconds per
request; it pays for itself when several systems, several kinds of caller, or
per-record and per-field rules are involved.
[`docs/why-typesys.md`](docs/why-typesys.md) goes through the trade-offs.

## Try it

```bash
npm install
npm run build
npm run demo          # http://localhost:4000: two domains, switch identity and policy engine
npm run mcp:http      # MCP at http://localhost:3939/mcp, Authorization: Bearer demo-maintainer-token
npm run studio        # http://localhost:4400: browse the model, compose and check queries
```

With PostgreSQL available:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/typesys
npm run migrate:postgres     # registry tables, audit_events, objects
npm test                     # Postgres-backed tests run only when DATABASE_URL is set
```

Other commands: `npm run lint`, `npm run typecheck`,
`npm run check:terminology`, `npm run smoke:mcp`, `npm run benchmark`,
`npm run load-test`, `npm run mutation` (deliberately breaks security checks
and confirms a test fails for each), and `npm run mission` (the same
squadron readiness app built with and without TypeSys).

## Packages

| Group | Packages |
|---|---|
| Runtime | `core` (model, registry, runtime, ABAC policy, audit), `policy-cedar` (Cedar policy engine) |
| Storage and sources | `adapter-postgres`, `adapter-http`, `adapter-mock-rest`, `adapter-in-memory`, `registry-store-postgres`, `workflow-postgres`, `redis` |
| Security | `auth-oidc` (JWT identity), `encryption` (field encryption at rest with blind indexes for equality), `kms-aws` (KMS-wrapped keys) |
| Access surfaces | `http` (REST API), `mcp-server`, `sdk`, `react`, `workflow` |
| Tooling | `cli` (YAML authoring, code generation), `devkit` (discovery, query validation, contract diff), `packs` (signed, versioned domain packages), `studio` (browser workbench), `engineer` (builds and verifies an application from a mission spec), `compiler` (compiles an application spec to TypeScript and React), `app` and `ui` (the runtime pieces compiled applications use: three-valued expressions and flow helpers, and React components with a separate design system) |
| Examples | `domain-airforce`, `domain-hospital`, `demo-web`, `mission-readiness`, `sortie-readiness`, `cold-chain` (with `examples/apps/cold-chain`, an application compiled over three services), `examples/services` (six independent services TypeSys reads over HTTP) |
| Evaluation | `evaluation` (harness comparing building with and without TypeSys, judged by hidden checks) |

## Status

The runtime is tested end to end against real PostgreSQL, Redis and a KMS
emulator, including mutation testing of the security checks and independent
adversarial reviews (in [`docs/reviews/`](docs/reviews/)). It has not had an
external security review, validation against a real KMS, or production-scale
load and high-availability testing. No package is published to npm yet.
[`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md) lists what
remains and [`docs/completeness.md`](docs/completeness.md) what is built.

## Documentation

- [`docs/README.md`](docs/README.md): index of the tutorial, how-to guides,
  reference and decision records.
- [`docs/architecture.md`](docs/architecture.md): the read, query, policy and
  Action paths call by call, with diagrams.
- [`docs/how-to/use-postgres.md`](docs/how-to/use-postgres.md),
  [`write-an-adapter.md`](docs/how-to/write-an-adapter.md),
  [`combine-multiple-sources.md`](docs/how-to/combine-multiple-sources.md),
  [`add-a-relationship-and-action.md`](docs/how-to/add-a-relationship-and-action.md):
  the storage and write paths in more depth.
- [`docs/for-agents.md`](docs/for-agents.md) and [`llms.txt`](llms.txt): for
  building agents against the MCP server.
- [`docs/adr/`](docs/adr/): 87 architecture decision records.

Versioning uses [changesets](https://github.com/changesets/changesets); see
[ADR-0020](docs/adr/0020-publish-infrastructure.md) for publishing.

MIT licensed.
