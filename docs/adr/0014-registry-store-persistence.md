# 0014. Registry Store Persistence

## Status

Accepted. **Partially superseded by
[ADR-0015](0015-postgres-registry-store.md)**: the Postgres-backed
`RegistryStore` this ADR described as a not-yet-built extension point
(`packages/registry-store-postgres`) now exists. The interface-boundary
decision here — `SemanticRegistry` depends only on `RegistryStore`, never a
concrete backend — is exactly what made that possible without touching
`SemanticRegistry` or any of its callers, and still stands. Read this ADR
for the *why an interface, not a hardcoded backend* reasoning; read
ADR-0015 for how the Postgres implementation actually works. The
historical claims below ("there is no Postgres-backed implementation")
describe the state of the codebase at the time this ADR was written, not
the current state — left unedited rather than rewritten, so this document
stays an accurate record of the decision as it was made.

## Context

The Semantic Registry's own metadata — registered Types, Relationships,
Actions, DataSources, Mappings, and the audit event log — needs durable
persistence in a real deployment, distinct from the Adapter layer's job of
resolving actual object *data* from enterprise systems. The mission brief
suggests SQL/PostgreSQL "where appropriate" for durable metadata, without
mandating it, and this project's non-goals explicitly exclude building "an
enterprise data lake" or over-building infrastructure the vertical slice
doesn't need.

## Decision

Define `RegistryStore` (`packages/core/src/registry/registry-store.ts`) as
an explicit persistence interface: `putType`/`getType`/`listTypeVersions`/
`listTypes`, `putRelationship`/`listRelationships`,
`putAction`/`getAction`/`listActions`, `putDataSource`/`getDataSource`,
`putMapping`/`listMappings`, `appendAuditEvent`/`listAuditEvents`.
`SemanticRegistry` depends only on this interface, never on a concrete
implementation.

The only implementation actually built in this codebase is
**`InMemoryRegistryStore`**
(`packages/core/src/registry/in-memory-registry-store.ts`) — a set of
in-process `Map`s, versioned per name using `semver.rcompare` for ordering
(ADR-0010). This is the default and only backend required for tests and for
the demo/MCP server, and it is what every test in `packages/core/test/` and
every domain-airforce/mcp-server test runs against.

**There is no Postgres-backed `RegistryStore` implementation in this
codebase.** Verified directly: `ls packages/` lists only `core`,
`adapter-in-memory`, `adapter-mock-rest`, `domain-airforce`, and
`mcp-server` — no `registry-store-postgres` or equivalent package exists.
A Postgres-backed implementation of the same `RegistryStore` interface is a
documented, optional, env-gated extension point for a later pass: it would
live in its own package (never a dependency of `@typesys/core` itself,
matching how domain packages depend on core and never the reverse), and
would be selected at bootstrap time (e.g. by an environment variable)
without any change to `SemanticRegistry` or any of its callers, since they
already only depend on the `RegistryStore` interface.

## Consequences

- Every test and the demo MCP server run against volatile, in-process
  storage — restarting the process loses all registered metadata and the
  audit log, which is acceptable for this pass and expected of a "not yet
  built" persistence layer, not a bug to work around.
- Because `SemanticRegistry` already depends only on the `RegistryStore`
  interface, adding a durable backend later is purely additive — no
  Registry, Runtime, or MCP server code needs to change, only which
  `RegistryStore` implementation is constructed at bootstrap.
- Do not describe a Postgres-backed registry store as existing,
  partially built, or "coming soon inside this package" — it is an
  interface-shaped extension point, and nothing more, as of this pass.
- The audit log's persistence is coupled to whichever `RegistryStore` is in
  use (`appendAuditEvent`/`listAuditEvents` are part of the same
  interface) — a durable audit trail therefore arrives for free once a
  durable `RegistryStore` exists, rather than needing its own separate
  persistence decision.

## Alternatives Considered

- **Build the Postgres-backed store now**: rejected for this pass — nothing
  in the vertical slice's tests or the MCP demo requires metadata to survive
  a process restart, and building a real migration/schema story for
  Postgres now, with no environment to run it against in this codebase,
  would be effort spent without a way to verify it end-to-end. The
  interface is deliberately positioned so this can be added later without
  disruption.
- **SQLite or another embedded file-backed store as a middle ground**:
  considered and rejected as unnecessary — it would still require the same
  interface work as a Postgres implementation for a durability guarantee
  (surviving a process restart on one machine) that isn't actually required
  by anything in this pass; better to leave the extension point open than
  to build a partial solution that would likely be replaced anyway.
