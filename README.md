# TypeS

TypeS is a domain-neutral enterprise semantic type system: a canonical
layer between physical enterprise systems (databases, REST APIs, legacy
platforms) and their consumers (applications and AI agents), so a consumer
can ask for an object, its relationships, its provenance, and the actions
it can perform, without knowing which system produced the answer. It is an
open, standards-based take on the same problem the C3 AI Type System and
Palantir Ontology address — built on JSON Schema 2020-12, a small embedded
ABAC policy engine, and the Model Context Protocol — not a clone of either.

## Packages

- **`packages/core`** (`@typesys/core`) — the meta-model, registry,
  runtime, policy engine, audit log, and domain-neutral base types/traits
  (Party, Person, Organization, Location, Asset, Event).
- **`packages/adapter-in-memory`** (`@typesys/adapter-in-memory`) — an
  in-memory repository adapter standing in for a database-backed store.
- **`packages/adapter-mock-rest`** (`@typesys/adapter-mock-rest`) — a
  mocked external REST system (its own snake_case shape and simulated
  network latency) plus the adapter that translates it into the canonical
  model.
- **`packages/domain-airforce`** (`@typesys/domain-airforce`) — the vertical
  slice domain: Aircraft/Component/MaintenanceEvent/WorkOrder, proving
  adapter substitution (Aircraft/Component on the in-memory adapter,
  MaintenanceEvent/WorkOrder on the mock-REST adapter) behind one
  consumer-facing model.
- **`packages/mcp-server`** (`@typesys/mcp-server`) — an MCP server exposing
  the semantic model as resources (browsing) and Actions as tools (governed
  invocation), with identity resolved fresh from a bearer token on every
  call.
- **`packages/demo-web`** (`@typesys/demo-web`) — an interactive web demo:
  browse the type catalog, explore Aircraft/Component/MaintenanceEvent/
  WorkOrder objects, navigate relationships, invoke the governed Action,
  and watch the ABAC policy engine and audit log react live as you switch
  identity. See [Demo](#demo) below.

## Getting started

```bash
npm install
npm run build      # tsc -b across the workspace
npm test           # vitest run — 36 tests across core/domain-airforce/mcp-server
npm run smoke:mcp  # spawns a real stdio MCP subprocess and runs the
                   # 7-step discover -> inspect -> retrieve -> navigate ->
                   # provenance -> list-actions -> invoke script end-to-end
npm run demo       # http://localhost:4000 — see Demo below
```

## Demo

```bash
npm run demo
```

opens an interactive web app at **http://localhost:4000** wired directly to
the real `SemanticRegistry`/`SemanticRuntime` (no mocked backend) — and, via
an in-process `@modelcontextprotocol/sdk` `Server`/`Client` pair sharing that
same runtime instance, to the real MCP server too. There is no build step;
it's a plain static `index.html`/`app.js`/`styles.css` served by a small
Express API (`packages/demo-web/src/server.ts`).

Three tabs:

- **Explorer** — browse the registered Types (click one for its full
  definition: schema, relationships, actions, computed properties, policies).
  Open `airforce.Aircraft` → `AF86-0147`, expand its `components` and
  `maintenance` relationships, drill into a related object, and try the
  **CreateMaintenanceWorkOrder** action. Switch the identity pill
  (Maintainer / Viewer / Anonymous) top-right and reopen the object: the
  `maintenanceStatus` property visibly locks for Viewer, and the Action
  becomes "Not authorized" — the same object, filtered live by the policy
  engine, not a different view.
- **Query** — the structured query DSL (`SemanticQuery`) that also happens
  to be the MCP `query` tool's input schema, with a couple of canned examples.
- **MCP Console** — the exact same operations, run against a real MCP
  `Server`/`Client` pair instead of the REST API. Call
  `CreateMaintenanceWorkOrder` as Viewer (denied, `isError: true`) and then
  as Maintainer (succeeds) to see the AI-agent path enforce the identical
  governance as the human path above.

The **Audit Log** drawer at the bottom is live across all three tabs —
every policy decision (allow/deny) and Action execution appends a row in
real time, regardless of which surface triggered it.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the layered architecture,
  with Mermaid diagrams for the component layout, a cross-adapter query,
  and a governed Action invocation.
- [`docs/semantic-meta-model.md`](docs/semantic-meta-model.md) — the
  canonical meta-model specification: Type, Property, Relationship, Action,
  ComputedProperty, Policy, DataSource, Mapping, and audit/Event.
- [`docs/adr/`](docs/adr/) — architecture decision records for the major,
  hard-to-reverse choices (schema representation, type identity,
  composition, adapters, policy, versioning, query DSL, MCP mapping, domain
  packaging, persistence).
- [`docs/developer-guide/adding-a-domain.md`](docs/developer-guide/adding-a-domain.md) —
  a walkthrough adding a brand-new domain (Hospital) without modifying
  `packages/core`.
