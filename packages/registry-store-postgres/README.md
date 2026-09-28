# @typesys/registry-store-postgres

A production PostgreSQL-backed `RegistryStore` for `@typesys/core`. See
[`docs/adr/0015-postgres-registry-store.md`](../../docs/adr/0015-postgres-registry-store.md)
for the full design rationale — this file is setup/operational instructions only.

## Setup

1. Point at a real Postgres. Either set discrete `PG*` env vars
   (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`,
   ...) or `DATABASE_URL` (a plain `postgresql://` connection string).
2. Apply migrations — **explicitly**, not automatically at app boot:
   ```bash
   npm run migrate
   ```
   This runs every `.sql` file in `migrations/` not yet recorded in
   `schema_migrations`, each inside its own transaction. Safe to re-run any
   time; already-applied files are skipped.
3. Construct the store:
   ```ts
   import { createPool, PostgresRegistryStore } from "@typesys/registry-store-postgres";
   import { SemanticRegistry } from "@typesys/core";
   import { airforceBindingRegistry } from "@typesys/domain-airforce"; // or your own domain's

   const pool = createPool(); // reads PG*/DATABASE_URL automatically
   const store = new PostgresRegistryStore(pool, airforceBindingRegistry);
   const registry = new SemanticRegistry(store);
   ```
4. Call `store.close()` (or `registry.close()`) on shutdown to end the pool
   gracefully.

## The one thing you cannot skip: `BindingRegistry`

`ComputedPropertyDefinition.compute` and `PreconditionSpec.check` are
JavaScript functions. Postgres cannot store them, and — per ADR-0015 — this
project will never execute code sourced from the database, so it doesn't
try. What gets persisted is a stable string key (`binding` / `bindingId`);
what makes a `Type`/`Action` usable again after reading it back is a
`BindingRegistry` supplying the real implementation for every key you might
encounter:

```ts
import type { BindingRegistry } from "@typesys/core";

const bindings: BindingRegistry = {
  computed: { computeReadinessStatus: /* the real function */ },
  preconditions: { maintenanceEventExists: /* the real function */ }
};
```

**Every process that constructs a `PostgresRegistryStore` needs this**, not
just the one that originally registered the domain. A read replica, a
reporting job, a second service reading the same Postgres registry — each
must independently supply the same (or an equivalent) `BindingRegistry` at
construction time. Forgetting a key doesn't fail silently: `getType`/
`getAction` throw `MissingBindingError`, naming exactly which key is
missing and on which Type/Action, the moment you try to read a record that
needs it. `putType`/`putAction` fail just as loudly, at write time, if a
computed property has no `binding` or a precondition meant to be persisted
has no `bindingId`.

If you're only ever going to author Types/Actions with no computed
properties or preconditions, none of this applies — pass no
`BindingRegistry` (or an empty one) and move on.

## Operational notes

- **Audit events are append-only at the database level.** A trigger
  rejects any `UPDATE` or `DELETE` on `audit_events`, unconditionally —
  there is no "edit/redact an audit row" path anywhere in this store, by
  design. A real deployment needing retention limits should handle that
  via partitioning/archival outside the application, not a delete path.
- **`TRUNCATE` bypasses that trigger.** It's a statement-level operation,
  not a row-level `DELETE`, so Postgres's `BEFORE DELETE ROW` trigger never
  fires for it — this is exactly why the test suite can `TRUNCATE` between
  runs. Never run `TRUNCATE audit_events` (or the other tables) against a
  real environment; it is only safe in test/dev databases.
- **Migrations are never run automatically.** `PostgresRegistryStore`'s
  constructor touches no schema. Run `npm run migrate` as an explicit
  deploy step — auto-migrating on every app boot risks multiple instances
  racing to alter the same schema concurrently.
- **`listAuditEvents` is paginated; nothing else is.** Types/Actions/
  Relationships/DataSources/Mappings are bounded by registered-metadata
  cardinality and are returned in full. Audit events are bounded by
  request volume and grow forever, so `listAuditEvents({ limit, before })`
  uses real keyset pagination (`(timestamp, id) < (cursor)`), not `OFFSET`
  — correct and index-friendly even as the table grows and rows are
  concurrently inserted.

## Testing

```bash
DATABASE_URL=postgresql://localhost:5432/typesys_test npm test
```

run from the repo root exercises this package's tests (both the shared
cross-backend contract suite and the Postgres-specific binding/durability/
immutability/migration tests) against a real database. Without
`DATABASE_URL` (or `PGHOST`) set, this package's tests are skipped — not
failed — so the rest of the monorepo's test suite never requires Postgres
to be installed.
