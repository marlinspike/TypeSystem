# @typesys/adapter-postgres

A real `Adapter` implementation backed by PostgreSQL — the proof that
this architecture works against a genuine database, not just the
in-memory/mock adapters the vertical slice ships with. See
[`docs/completeness.md`](../../docs/completeness.md) and
[`docs/how-to/write-an-adapter.md`](../../docs/how-to/write-an-adapter.md).

## Setup

```bash
npm run migrate --workspace=@typesys/adapter-postgres
```

reads `DATABASE_URL`/`PG*` env vars, same as
`@typesys/registry-store-postgres`. **If you run both packages' migrations
against the same database** (a legitimate deployment shape — one Postgres
instance holding both the registry's metadata and your domain's data),
note that each package tracks its own applied migrations in its own
table (`registry_postgres_schema_migrations` /
`adapter_postgres_schema_migrations`) specifically so one package's
migration history can never satisfy another's — an earlier version of
both packages shared a plain `schema_migrations` name and that collision
was a real bug caught while building this package.

## Use it

```ts
import { createPool, PostgresRepositoryAdapter } from "@typesys/adapter-postgres";

const pool = createPool();
const adapter = new PostgresRepositoryAdapter(pool, "fleet-pg", "Fleet Database");

await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", name: "Real Widget", status: "active" });

await registry.registerMapping({
  id: "map-widget", typeName: "fleet.Widget", target: "property", targetName: "*",
  dataSourceId: "fleet-pg", operation: "get", resolutionMode: "live"
});
const runtime = new SemanticRuntime(registry, [adapter], policyEngine);
```

## The schema is generic on purpose, for now

One table, `objects (type_name, object_id, values jsonb)` — any
registered Type can use it without a bespoke migration. `queryByType`
filters in application code via `@typesys/core`'s `matchesFilter` (same
as the in-memory/mock-rest adapters); `resolveRelationship`'s
`byForeignKey:<field>` case is pushed down as a real indexed JSONB query
(`values ->> field = ...`, backed by the migration's GIN index) rather
than fetching every row — the one place being backed by a real database
changes *how* resolution should be implemented, not just where the bytes
physically live.

**Graduate off this** for any Type with real production volume or a
shape that benefits from real columns, indexes, and constraints —
write a Type-specific `Adapter` with its own table, following the same
four-method interface. This package is the reference pattern for "any
Type against real Postgres, no bespoke schema required," not a
recommendation to keep every Type on one generic JSONB table forever.

## Verify it

```bash
DATABASE_URL=postgresql://localhost:5432/typesys_test npm test
```

exercises the adapter through a real `SemanticRuntime` — object
retrieval, filtered queries, and both relationship conventions
(`byForeignKey`/`byOwnField`) — against actual Postgres rows, not mocks.
Skipped, not failed, without `DATABASE_URL`/`PGHOST` set.
