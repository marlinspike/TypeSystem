import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  SemanticRegistry,
  SemanticRuntime,
  InMemoryRegistryStore,
  AbacPolicyEngine,
  allowAllRule,
  type SemanticTypeSchema,
  type Identity
} from "@typesys/core";
import { PostgresRepositoryAdapter } from "../src/postgres-repository-adapter.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

describe.skipIf(!hasDb)("PostgresRepositoryAdapter", () => {
  let pool: Pool;
  let adapter: PostgresRepositoryAdapter;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    adapter = new PostgresRepositoryAdapter(pool, "fleet-pg", "fleet-database");
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE objects`);
  });

  async function buildRuntimeWithFleet(): Promise<SemanticRuntime> {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());

    const widgetSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/fleet/Widget/1.0.0",
      title: "Widget",
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } },
      "x-relationships": {
        parts: {
          target: "fleet.Part",
          cardinality: "one-to-many",
          resolution: { dataSourceId: "fleet-pg", operation: "byForeignKey:widgetId" }
        },
        depot: {
          target: "fleet.Depot",
          cardinality: "one-to-one",
          resolution: { dataSourceId: "fleet-pg", operation: "byOwnField:depotId" }
        }
      },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(widgetSchema, { name: "fleet.Widget", version: "1.0.0" });

    const partSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/fleet/Part/1.0.0",
      title: "Part",
      type: "object",
      properties: { id: { type: "string" }, widgetId: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(partSchema, { name: "fleet.Part", version: "1.0.0" });

    const depotSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/fleet/Depot/1.0.0",
      title: "Depot",
      type: "object",
      properties: { id: { type: "string" }, city: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(depotSchema, { name: "fleet.Depot", version: "1.0.0" });

    for (const typeName of ["fleet.Widget", "fleet.Part", "fleet.Depot"]) {
      await registry.registerMapping({
        id: `map-${typeName}`,
        typeName,
        target: "property",
        targetName: "*",
        dataSourceId: "fleet-pg",
        operation: "get",
        resolutionMode: "live"
      });
    }

    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    return new SemanticRuntime(registry, [adapter], policyEngine);
  }

  it("round-trips an object through a real Postgres insert and read via the runtime", async () => {
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", name: "Real Widget", status: "active", depotId: "depot-1" });

    const runtime = await buildRuntimeWithFleet();
    const object = await runtime.getObject("fleet.Widget", "widget-1", identity);
    expect(object.values.name).toBe("Real Widget");
    expect(object.values.status).toBe("active");
  });

  it("supports query filtering, pushed down through matchesFilter against real rows", async () => {
    await adapter.put("fleet.Widget", "w1", { id: "w1", name: "A", status: "active" });
    await adapter.put("fleet.Widget", "w2", { id: "w2", name: "B", status: "retired" });
    await adapter.put("fleet.Widget", "w3", { id: "w3", name: "C", status: "active" });

    const runtime = await buildRuntimeWithFleet();
    const result = await runtime.query({ type: "fleet.Widget", filter: { property: "status", operator: "eq", value: "active" } }, identity);
    expect(result.items.map((i) => i.objectId).sort()).toEqual(["w1", "w3"]);
  });

  it("resolves a one-to-many relationship via a real byForeignKey JSONB query", async () => {
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", name: "Real Widget" });
    await adapter.put("fleet.Part", "part-1", { id: "part-1", widgetId: "widget-1" });
    await adapter.put("fleet.Part", "part-2", { id: "part-2", widgetId: "widget-1" });
    await adapter.put("fleet.Part", "part-3", { id: "part-3", widgetId: "widget-2" }); // different widget — must not show up

    const runtime = await buildRuntimeWithFleet();
    const parts = await runtime.getRelationship("fleet.Widget", "widget-1", "parts", identity);
    expect(parts.map((p) => p.objectId).sort()).toEqual(["part-1", "part-2"]);
  });

  it("resolves a one-to-one relationship via byOwnField", async () => {
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", depotId: "depot-1" });
    await adapter.put("fleet.Depot", "depot-1", { id: "depot-1", city: "Dayton" });

    const runtime = await buildRuntimeWithFleet();
    const depots = await runtime.getRelationship("fleet.Widget", "widget-1", "depot", identity);
    expect(depots).toHaveLength(1);
    expect(depots[0]?.values.city).toBe("Dayton");
  });

  it("put() upserts — writing the same object id twice replaces, not duplicates", async () => {
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", status: "active" });
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1", status: "retired" });

    const runtime = await buildRuntimeWithFleet();
    const object = await runtime.getObject("fleet.Widget", "widget-1", identity);
    expect(object.values.status).toBe("retired");
  });

  it("delete() removes the row", async () => {
    await adapter.put("fleet.Widget", "widget-1", { id: "widget-1" });
    await adapter.delete("fleet.Widget", "widget-1");

    const { values } = await adapter.resolveProperties("fleet.Widget", "widget-1", []);
    expect(values).toEqual({});
  });

  it("migrations are safely re-runnable, and use a package-scoped tracking table (not a name shared with another package)", async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain("0001_init.sql");

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'adapter_postgres_schema_migrations'`
    );
    expect(rows).toHaveLength(1);
  });
});
