# How to use Postgres for the registry

`@typesys/registry-store-postgres` is a full `RegistryStore`
implementation — swap it in and nothing else changes, because
`SemanticRegistry` only ever depends on the `RegistryStore` interface
([ADR-0014](../adr/0014-registry-store-persistence.md),
[ADR-0015](../adr/0015-postgres-registry-store.md)). Full setup/
operational detail lives in
[`packages/registry-store-postgres/README.md`](../../packages/registry-store-postgres/README.md) —
this page is the short version.

## Set up

```bash
# point at a real database via PG* env vars or DATABASE_URL
npm run migrate:postgres   # explicit, never run automatically at app boot
```

## Swap it in

```ts
import { createPool, PostgresRegistryStore } from "@typesys/registry-store-postgres";
import { SemanticRegistry } from "@typesys/core";
import { airforceBindingRegistry } from "@typesys/domain-airforce"; // or your own domain's

const pool = createPool(); // reads PG*/DATABASE_URL automatically
const store = new PostgresRegistryStore(pool, airforceBindingRegistry);
const registry = new SemanticRegistry(store);
```

Everything else — `registerDomain`, `SemanticRuntime`, adapters — is
identical to the in-memory path. This is the entire migration.

## The one thing that's different from the in-memory store

Computed properties and preconditions carry live JavaScript functions
(`compute`, `check`). Postgres can't store a function, so it stores a
stable name (`binding`/`bindingId`) instead, and **every process that
reads a Type/Action back must independently supply the real
implementation** via a `BindingRegistry` — the same process that wrote it
doesn't get a free pass; a second service, a read replica, a reporting
job all need their own copy. See [`add-a-type.md`](add-a-type.md) for how
a binding is declared, and
[`packages/domain-airforce/src/bindings.ts`](../../packages/domain-airforce/src/bindings.ts)
for what supplying one looks like in practice.

Forgetting one isn't a silent bug: `getType`/`getAction` throw
`MissingBindingError`, naming exactly which key is missing, the moment
you try to read a record that needs it. Persisting a computed property
with no `binding` fails the same way, at write time.

## Operational notes worth knowing before you rely on this

- Audit events are **append-only at the database level** — a trigger
  rejects `UPDATE`/`DELETE` on `audit_events` unconditionally. There is no
  "edit an audit row" path, anywhere, by design.
- `listAuditEvents({limit, before})` uses real keyset pagination, not
  `OFFSET` — safe against a table that grows forever.
- Migrations are plain tracked SQL files
  (`packages/registry-store-postgres/migrations/`), never run
  automatically by the store's constructor — a deploy-time step, not an
  app-boot side effect.

## Verify it

```bash
DATABASE_URL=postgresql://localhost:5432/typesys_test npm test
```

runs the same contract-test suite the in-memory store passes
(`packages/core/src/testing/registry-store-contract.ts`) against a real
database, plus Postgres-specific tests for binding rehydration and the
audit-immutability trigger. Skipped, not failed, without `DATABASE_URL`/
`PGHOST` set.
