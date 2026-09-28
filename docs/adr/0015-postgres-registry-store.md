# 0015. Production PostgreSQL `RegistryStore`

## Status

Accepted

## Context

ADR-0014 deferred a Postgres-backed `RegistryStore` as a documented,
optional extension point — no PostgreSQL was installed in the original
environment, and the in-memory implementation was sufficient to prove the
architecture. That extension point is now being built for real, as a
production-grade implementation, in a new `packages/registry-store-postgres`
package (`@typesys/registry-store-postgres`), never a dependency of
`@typesys/core` (ADR-0014 still holds).

Two things make this harder than "write some SQL," and both had to be
decided before writing any code:

**1. Two parts of the meta-model carry live JavaScript closures.**
`ComputedPropertyDefinition.compute` (`packages/core/src/model/type.ts`) and
`PreconditionSpec.check` (`packages/core/src/model/action.ts`) are
functions — `(ctx) => Promise<unknown>` and `(ctx) => Promise<boolean>`
respectively. `InMemoryRegistryStore` never notices this: it holds the same
JS object reference the registry built, so the closures survive for free.
A `RegistryStore.putType()`/`putAction()` call against Postgres must
serialize to JSON — and a function cannot be serialized to JSON. This is
not a Postgres-specific problem; it is the general problem of persisting
"behavior" versus persisting "data," and this codebase already has a
precedent for solving it: `Adapter` instances are never persisted either —
`DataSource` (data) is looked up in the registry, and the actual `Adapter`
(code) is supplied to `SemanticRuntime`'s constructor at process boot
(`packages/domain-airforce/src/setup.ts`). The same shape of answer applies
here.

**2. Two latent, previously-undetected correctness issues surface the
moment persistence has to be exact.** `InMemoryRegistryStore.putRelationship`
dedupes only by `(name, version)`, so re-registering the *same* type name at
a *new* version leaves the old version's relationship rows sitting in the
list forever — `listRelationships(sourceType)` silently accumulates stale
entries across type versions. And `listAuditEvents()` returns the entire
table with no bound — harmless for an in-memory `Map` in a demo process,
a real availability risk against a table that grows forever in production.
Both are fixed as part of this change, in both backends, because shipping
"production ready" Postgres on top of unfixed semantics would just be
"production ready bugs, faithfully replicated."

## Decision

### Behavior is never persisted; a `BindingRegistry` resolves it at read time

Two new fields are added to the meta-model, both required for anything
that will ever be read back from Postgres, both optional so
`InMemoryRegistryStore` and every existing in-process caller are
unaffected:

- `ComputedPropertyDefinition.binding: string` (`type.ts`) — already exists
  informally as `XComputedSpec.binding` in the vocabulary and is already
  used to look up `computedImplementations` at `registerType()` time
  (`registry.ts`); it was simply being discarded afterward. It is now
  carried onto the persisted `ComputedPropertyDefinition` itself.
- `PreconditionSpec.bindingId?: string` (`action.ts`) — new. Preconditions
  are authored as literal inline closures today
  (`packages/domain-airforce/src/actions/create-maintenance-work-order.ts`);
  persisting one now requires naming it.

`PostgresRegistryStore` is constructed with a `BindingRegistry`:

```ts
export interface BindingRegistry {
  computed: Record<string, (ctx: ComputeContext) => Promise<unknown>>;
  preconditions: Record<string, (ctx: ActionContext) => Promise<boolean>>;
}
```

- `putType`/`putAction` strip `compute`/`check` before writing and persist
  only `{ name, dependsOn, resolutionMode, binding }` /
  `{ description, bindingId }`. If a computed property has no `binding`,
  or a precondition meant to be persisted has no `bindingId`, the write
  throws immediately — failing loudly at write time beats silently
  dropping behavior and discovering it the first time the property
  resolves to `undefined` in production.
- `getType`/`getAction` look up each `binding`/`bindingId` in the
  `BindingRegistry` supplied to *that store instance* and re-attach the
  live function. An unresolvable binding throws `MissingBindingError`
  immediately, naming the type/action and the missing key — never returns
  a `TypeDefinition` with a silently-broken computed property.

The important consequence, stated explicitly because it is easy to miss:
**a process that only reads from an already-populated Postgres registry —
a read replica, a reporting job, a second service — must independently
supply a `BindingRegistry` containing every binding it might encounter.**
The database never stores or executes code; every process that touches
computed properties or preconditions owns its own implementations, wired
at boot, exactly like adapters. This is stated as a requirement in
`packages/registry-store-postgres/README.md`, not just this ADR.

### Schema: six normalized tables, JSONB for the parts that are already JSON

```
types            (id, name, version, extends, traits, description, schema,
                  action_names, computed_properties, deprecated, aliases,
                  created_at, updated_at)   UNIQUE(name, version)
relationships    (id, name, source_type, target_type, cardinality,
                  inverse_name, edge_schema, resolution, version,
                  deprecated, created_at)   UNIQUE(source_type, name)
actions          (id, name, version, description, applicable_types,
                  input_schema, output_schema, authorization_policy,
                  preconditions, implementation, side_effects, idempotency,
                  audit_required, deprecated, created_at, updated_at)
                                            UNIQUE(name, version)
data_sources     (id, name, kind, config, created_at)
mappings         (id, type_name, target, target_name, data_source_id,
                  operation, resolution_mode, priority, created_at)
audit_events     (id, "timestamp", subject_id, action, resource_type_name,
                  resource_object_id, resource_property_path, decision,
                  reason, outcome, details)
```

- `schema`, `applicable_types`, `input_schema`, `output_schema`,
  `computed_properties`, `preconditions`, `resolution`, `implementation`,
  `edge_schema`, `config`, `details`, `traits`, `aliases`, `deprecated` are
  `JSONB` — every one of them was already a plain JSON-shaped value in the
  TypeScript model (JSON Schema documents, small objects/arrays), so JSONB
  is not a workaround, it is the natural representation.
- `relationships` is keyed `UNIQUE(source_type, name)` — **not**
  `(source_type, name, version)`. `RegistryStore.listRelationships` has no
  version parameter and never returns anything but "the current
  relationships for this source type," so `putRelationship` upserts on
  `(source_type, name)`, replacing whatever was there. This is the fix for
  the accumulation bug described above, and it is applied to
  `InMemoryRegistryStore` too (`putRelationship` now dedupes by
  `(sourceType, name)` instead of `(name, version)`), with a regression
  test (`registry.test.ts`) proving that re-registering a type at a new
  version leaves exactly the new version's relationships behind.
- `mappings` intentionally has **no** unique constraint beyond its primary
  key: `MappingResolver` already supports a wildcard (`targetName: "*"`)
  mapping coexisting with a more specific per-property mapping for the same
  type, and a real deployment may register more than one candidate mapping
  per `(type, target, targetName)` for source-priority/conflict-resolution
  purposes (`Mapping.priority`, not yet exercised by the runtime but part
  of the model). Constraining this now would foreclose that.
- Semver range resolution (`getType`/`getAction` with a `versionRange`)
  stays in application code, not SQL: `PostgresRegistryStore` fetches every
  row for a `name` and calls the *exact same* `resolveVersion` helper
  (extracted from `InMemoryRegistryStore` into
  `packages/core/src/registry/version-resolution.ts`) that the in-memory
  store uses. Both backends now share one semver-matching implementation,
  so they cannot silently drift into different versioning semantics.

### Audit events are append-only at the database level, not just by convention

The mission brief calls for "immutable security events." A `BEFORE UPDATE
OR DELETE` trigger on `audit_events` raises an exception unconditionally —
no application bug, compromised credential short of superuser, or future
maintainer can quietly edit or delete an audit row. This is a real
constraint the in-memory store cannot offer (nothing stops JS code from
mutating an array) and one of the concrete reasons a durable store earns
its complexity here.

### `listAuditEvents` becomes bounded and paginated; nothing else does

`RegistryStore.listAuditEvents()` returns `Promise<AuditEvent[]>` today —
unbounded. Types, relationships, actions, data sources, and mappings are
all bounded by *registered metadata* cardinality (how many domain packages
are installed — realistically dozens to low thousands, ever), so their
`list*` methods stay unbounded on purpose; paginating them would be
unneeded ceremony. Audit events are bounded by *request volume* and grow
without limit for as long as the system runs. The interface changes to:

```ts
listAuditEvents(opts?: { limit?: number; before?: string }): Promise<QueryResult<AuditEvent>>;
```

reusing the existing `QueryResult<T>` shape (`packages/core/src/model/query.ts`)
rather than inventing a second pagination convention. `before` is an audit
event `id` (ULIDs are lexicographically sortable by creation time, so a
plain string comparison cursor works without a second index). Both
`InMemoryRegistryStore` and `PostgresRegistryStore` implement the same
signature; `SemanticRegistry.listAuditEvents`, the two existing tests, and
the demo web app's `/api/audit` endpoint are updated to the new shape
(`packages/domain-airforce/test/create-maintenance-work-order-action.test.ts`,
`packages/demo-web/src/server.ts`).

### Migrations are explicit and versioned, never run implicitly at boot

`PostgresRegistryStore`'s constructor does not touch schema. A small,
dependency-free migration runner
(`packages/registry-store-postgres/src/migrate.ts`, ~50 lines) reads
numbered `.sql` files from `migrations/`, tracks applied ones in a
`schema_migrations` table, and applies pending ones inside a transaction —
invoked explicitly via `npm run migrate` in that package, or by calling
`runMigrations(pool)` directly from test setup. Auto-migrating inside the
store constructor was considered and rejected: multiple application
instances starting concurrently would race to alter the same schema, and
coupling "the app started" to "the schema changed" is a well-known
production anti-pattern this project has no reason to reproduce.

### Connection configuration is `pg`'s own, not reinvented

`PostgresRegistryStore` takes a `pg.Pool` (or a connection config object it
passes straight to `new Pool(...)`) rather than parsing its own connection
string format. `pg.Pool` already reads the standard `PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, etc. environment
variables natively, or accepts an explicit `connectionString` — SSL
included. `DATABASE_URL` is the one piece `pg` itself does *not* read
automatically (it's an ecosystem convention, not a `pg` feature); the
`createPool` helper (`src/pool.ts`) wires it in explicitly as a fallback
`connectionString` so both configuration styles work. Reinventing the rest
of that parsing would be pure risk for zero benefit. Pool sizing
(`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`) is exposed with
sane defaults (`max: 10`, `idleTimeoutMillis: 30_000`,
`connectionTimeoutMillis: 5_000`) and is overridable by the caller.

`RegistryStore` gains an optional `close?(): Promise<void>` for graceful
shutdown (`PostgresRegistryStore.close()` ends the pool;
`InMemoryRegistryStore.close()` is a no-op added for interface symmetry).
Nothing currently calls it in the vertical slice's own processes (they run
until killed), but tests and any future serverless/short-lived caller need
it, and adding it now costs nothing.

### Testing: one contract suite for pure data, one Postgres-only suite for behavior rehydration

`packages/core/test/registry-store-contract.ts` exports a reusable
`runRegistryStoreContractTests(name, makeStore)` function exercising every
`RegistryStore` method against fixtures that carry **no** functions —
proving `InMemoryRegistryStore` and `PostgresRegistryStore` behave
identically for everything that is genuinely just data (versioning,
aliasing, the relationship-upsert fix, audit pagination, cursor behavior).
`packages/registry-store-postgres/test/postgres-registry-store.test.ts`
additionally covers what only Postgres needs to prove: a computed
property's `compute` function surviving a real write-then-read round trip
through a `BindingRegistry`, a precondition's `check` doing the same, a
missing binding throwing `MissingBindingError`, the audit-immutability
trigger actually rejecting an `UPDATE`/`DELETE`, and migrations applying
cleanly to an empty database and being safely re-runnable.

These tests require a real reachable PostgreSQL (`DATABASE_URL` or `PG*`
env vars) and are skipped — not failed — when one is not configured, via
`describe.skipIf(!hasDatabaseUrl)`, matching the pattern already named for
this in ADR-0014's original plan.

## Consequences

- Any domain package that wants its computed properties or preconditions to
  survive a restart against Postgres must name them with a stable
  `binding`/`bindingId` and supply the matching implementation in a
  `BindingRegistry` at every process that constructs a
  `PostgresRegistryStore` — a small but real authoring requirement that
  `InMemoryRegistryStore` users never have to think about.
- `RegistryStore.listAuditEvents` is a breaking signature change from
  `AuditEvent[]` to `QueryResult<AuditEvent>`. Three in-repo call sites
  were updated; anything outside this repo consuming the interface would
  need to update too. This was judged worth doing now, once, rather than
  shipping a Postgres store that faithfully reproduces an unbounded query
  and fixing it later as an even-more-breaking change.
- `packages/core` gains one new exported helper
  (`resolveVersion`) and two new optional model fields; it gains no new
  dependencies and still knows nothing about Postgres.
- The audit-immutability trigger means there is deliberately no
  "redact/expunge an audit event" operation anywhere in this system. A
  real deployment needing legal-hold-style retention limits would handle
  that via table partitioning/archival outside the application, not by
  giving the app a delete path.

## Alternatives Considered

- **Serializing closures as source strings and `eval`/`new Function`-ing
  them back**: rejected outright, not just as unnecessary but as a real
  security hazard — it would mean executing code sourced from database
  rows, in a system whose entire premise (ADR-0009) is that the runtime is
  a trusted policy/audit boundary. A `BindingRegistry` keeps "code" as
  code, deployed with the process, and "data" as data, shared via the
  database, which is the same line this project already drew for adapters.
- **An ORM (Prisma, Drizzle, TypeORM)**: considered and rejected for this
  size of schema (six tables, simple CRUD, no complex joins beyond
  version-range filtering already done in application code). An ORM adds a
  generated-client build step (Prisma) or a real dependency + query-builder
  surface (Drizzle/TypeORM) for a schema small enough that hand-written
  parameterized SQL is both less code and more legible. Drizzle specifically
  is the one worth reconsidering if this schema grows materially (it adds
  no codegen step and stays close to SQL) — noted for later, not needed now.
- **A migration framework (`node-pg-migrate`, Flyway-for-Node, etc.)**:
  rejected in favor of a ~50-line tracked-SQL-files runner. The behavior
  needed — ordered files, tracked in a table, idempotent, transactional —
  is small enough to own directly without a new dependency, and every
  framework in this space is, at its core, exactly this pattern.
- **Auto-running migrations in the `PostgresRegistryStore` constructor**:
  rejected — see Decision above. Migration is a deploy-time concern,
  application startup is a runtime concern, and conflating them invites
  exactly the multi-instance race conditions this decision exists to avoid.
- **Versioning relationships independently of their owning type**
  (`UNIQUE(source_type, name, version)`, keeping historical versions):
  rejected — nothing in `RegistryStore` can address a relationship by
  version (`listRelationships` takes no version parameter), so retaining
  version history for a value nothing can ever retrieve by version is
  complexity with no observable benefit. If relationship history is ever
  needed, it should be added as a real, queryable capability (a version
  parameter on `listRelationships`), not smuggled in as unreachable rows.
- **Postgres-native semver (an extension, or hand-rolled range parsing in
  SQL)**: rejected — the `semver` npm package is already a dependency and
  already correct; duplicating its range logic in SQL would be a second
  implementation of the same rules, guaranteed to drift eventually.
