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
registered Type can use it without a bespoke migration.

`queryByType` and `aggregate` compile the filter — the caller's, and any
authorization plan the runtime pushed into it (ADR-0038) — to a
parameterized `WHERE` over the JSONB column
([ADR-0040](../../docs/adr/0040-adapter-filter-capabilities-and-sql-pushdown.md)).
Each condition compiles *exactly* — string, boolean, and `null` equality,
through the GIN index with `@>` — or as a *superset*: numeric conditions,
bounded in exact `numeric` arithmetic by the doubles neighboring the filter's
number, so no stored decimal JavaScript would match is ever excluded
([ADR-0044](../../docs/adr/0044-provable-numeric-pushdown.md)); and
`contains`/`icontains`, narrowed by JSON type. Every row read is re-checked
with `matchesFilter`, so a superset is only ever narrowed. When the whole filter is exact and there is
no `sort`, `LIMIT`/`OFFSET` run in SQL and a page reads only its rows;
otherwise the adapter sorts and pages the SQL-narrowed rows itself, with the
same order and cursors. `resolveRelationship`'s `byForeignKey:<field>` case
is an indexed JSONB query too.

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
