import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { SemanticRegistry, type SemanticTypeSchema } from "@typesys/core";
import { PostgresRegistryStore } from "../src/postgres-registry-store.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

/**
 * ADR-0015 accepted an "unverified-at-scale multi-instance story" for this
 * store (docs/PRODUCTION-READINESS.md item 7). These tests are the
 * verification: several replicas, each with its own connection pool and
 * SemanticRegistry, against one database. Each test gets a private schema
 * (via search_path), so it starts from a genuinely empty database without
 * touching the tables other test files use.
 */
describe.skipIf(!hasDb)("PostgresRegistryStore across instances (ADR-0025)", () => {
  const schema = `multi_instance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pools: Pool[] = [];
  let admin: Pool;

  function replicaPool(): Pool {
    const pool = createPool({ max: 4, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  }

  function baseSchema(name: string): SemanticTypeSchema {
    const short = name.split(".")[1]!;
    return { $id: `https://typesys.dev/types/test/${short}/1.0.0`, title: short, type: "object", properties: { id: { type: "string" } } };
  }

  beforeAll(async () => {
    admin = createPool({ max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("lets several replicas run migrations at once: exactly one applies each, none fail", async () => {
    const results = await Promise.all([replicaPool(), replicaPool(), replicaPool()].map((pool) => runMigrations(pool)));
    const appliedCounts = results.map((r) => r.applied.length);
    // One run applied every migration; the others waited on the lock, then found them applied.
    expect(appliedCounts.filter((n) => n > 0)).toHaveLength(1);
    const total = results[0]!.applied.length + results[0]!.alreadyApplied.length;
    expect(results.every((r) => r.applied.length + r.alreadyApplied.length === total)).toBe(true);
  });

  it("sees another replica's registrations immediately, and can compose on top of them", async () => {
    const a = new SemanticRegistry(new PostgresRegistryStore(replicaPool()));
    const b = new SemanticRegistry(new PostgresRegistryStore(replicaPool()));

    await a.registerType(baseSchema("test.Base"), { name: "test.Base", version: "1.0.0" });
    expect((await b.getType("test.Base"))?.version).toBe("1.0.0");

    // B extends a type that only A registered: composition reads the base from the shared store.
    const derived: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Derived/1.0.0",
      title: "Derived",
      type: "object",
      properties: { extra: { type: "string" } }
    };
    await b.registerType(derived, { name: "test.Derived", version: "1.0.0", extends: "test.Base" });
    expect((await a.getType("test.Derived"))?.name).toBe("test.Derived");
  });

  it("keeps every replica's audit events, interleaved into one log", async () => {
    const a = new SemanticRegistry(new PostgresRegistryStore(replicaPool()));
    const b = new SemanticRegistry(new PostgresRegistryStore(replicaPool()));
    const event = (id: string, subjectId: string) => ({
      id,
      timestamp: new Date().toISOString(),
      subjectId,
      action: "read",
      resource: { typeName: "test.Base" },
      decision: "allow" as const
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).appendAuditEvent(event(`evt-mi-${String(i).padStart(2, "0")}`, i % 2 === 0 ? "a" : "b")))
    );

    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await a.listAuditEvents({ limit: 7, before: cursor });
      page.items.filter((e) => e.id.startsWith("evt-mi-")).forEach((e) => seen.add(e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(20); // nothing lost or duplicated across replicas or pages
  });

  it("settles concurrent registration of the same type version to one consistent definition", async () => {
    const replicas = [0, 1, 2, 3].map(() => new SemanticRegistry(new PostgresRegistryStore(replicaPool())));
    await Promise.all(
      replicas.map((r, i) =>
        r.registerType({ ...baseSchema("test.Racy"), description: `from replica ${i}` }, { name: "test.Racy", version: "1.0.0" })
      )
    );
    const versions = await replicas[0]!.listTypeVersions("test.Racy");
    expect(versions).toHaveLength(1);
    // Every replica now reads the same winner.
    const seen = await Promise.all(replicas.map(async (r) => (await r.getType("test.Racy"))?.schema.description));
    expect(new Set(seen).size).toBe(1);
  });
});
