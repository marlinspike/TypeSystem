# 0006. Adapter Architecture

## Status

Accepted

## Context

"What something IS" (the Type) must be independent of "where its data comes
from" (a specific database, API, or transport). The mission brief calls for
proving this with at least two different backing styles for the same
consumer-facing model — e.g. Aircraft on a database-flavored store,
MaintenanceEvent on a mocked external REST system — with zero
adapter-specific branching in consumer code.

## Decision

Introduce three cooperating concepts (`packages/core/src/model/data-source.ts`,
`packages/core/src/runtime/adapter.ts`):

- **`DataSource`** — `{id, name, kind: "in-memory" | "mock-rest" |
  "postgres" | string, config?}`: a connection-level reference to an
  enterprise system.
- **`Mapping`** — `{id, typeName, target: "property" | "relationship" |
  "action", targetName, dataSourceId, operation, resolutionMode, priority?}`:
  binds one Type's property/relationship/action to a `DataSource` +
  adapter-understood `operation` string.
- **`Adapter`** — the interface every adapter style implements identically:
  `resolveProperties(typeName, objectId, propertyNames)`,
  `queryByType(typeName, filter?, limit?, cursor?)`,
  `resolveRelationship(relationship, sourceObjectId)`,
  `executeAction(action, input, ctx)`.

`SemanticRuntime` never branches on which `Adapter` implementation it holds
— it looks up the adapter by `dataSourceId` (via `MappingResolver` for
properties, or directly off `relationship.resolution.dataSourceId` /
`action.implementation.dataSourceId`) and calls the same four methods
regardless.

Two adapter styles are actually built, proving substitution:
**`InMemoryRepositoryAdapter`** (`packages/adapter-in-memory`) — a seeded
in-memory map standing in for a database-backed repository, returning
values already in canonical shape — and **`MockRestAdapter`** +
**`MockRestClient`** (`packages/adapter-mock-rest`) — the client simulates a
real external REST system's own record shape (`event_id`, `aircraft_tail`,
`event_type`, snake_case throughout) and simulated network latency; the
adapter is solely responsible for translating that shape into the
canonical model (`toCanonicalMaintenanceEvent`/`toCanonicalWorkOrder`).
`packages/domain-airforce/test/adapter-substitution.test.ts` proves a
single `runtime.query()` call resolves `Aircraft.components` (in-memory
adapter) and `Aircraft.maintenance` (mock-REST adapter) inline, asserting
only on the returned values — never on which adapter produced them.

## Consequences

- Adding a new adapter style requires only implementing the four-method
  `Adapter` interface; the Runtime and Registry require no changes.
- Translating an external system's field names/shape into the canonical
  model is the adapter's job, not the Type's — a Type's schema never leaks
  a source system's naming (`aircraft_tail` never appears anywhere in the
  canonical model).
- Every `Mapping` in the airforce domain uses a wildcard `targetName: "*"`,
  since both adapter styles return a whole object per lookup — the model
  supports a more granular per-property `Mapping` (specific `targetName`),
  but nothing in this codebase currently needs it.
- A Postgres-backed adapter/registry-store pair is a documented extension
  point (see ADR-0014), not built in this pass — no `packages/*-postgres`
  package exists in this repository.

## Alternatives Considered

- **A single universal adapter with per-source `if` branches inside it**:
  rejected — it would recreate exactly the coupling the mission brief warns
  against (consumer/runtime code that has to know how many source systems
  contributed to an object and how each one shapes its data), just moved
  one layer down instead of eliminated.
- **ORM-style per-Type repository classes generated from the schema**:
  rejected as unneeded code generation for this pass ("avoid unnecessary
  code generation if runtime interpretation is cleaner" — mission brief).
  Runtime interpretation of a `Mapping` record, dispatched to a
  hand-written `Adapter`, is simpler to build and simpler to substitute
  than generating and regenerating repository classes per Type per adapter
  kind.
