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
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { PostgresRepositoryAdapter } from "../src/postgres-repository-adapter.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

/**
 * Every other multi-source test in this repo combines two in-memory-flavored
 * adapters (a synthetic fixture pair in
 * packages/core/test/multi-source-property-composition.test.ts) or
 * InMemoryRepositoryAdapter + MockRestAdapter (domain-airforce). This is the
 * first test to combine a REAL PostgresRepositoryAdapter with a second,
 * different real adapter (InMemoryRepositoryAdapter) in one object graph —
 * proving both ADR-0006 (relationships across adapters) and ADR-0023
 * (multi-source property composition) hold for Postgres specifically, not
 * just for the two adapters that happened to be built first.
 */
describe.skipIf(!hasDb)("PostgresRepositoryAdapter combined with a second, different adapter", () => {
  let pool: Pool;
  let pgAdapter: PostgresRepositoryAdapter;
  let memAdapter: InMemoryRepositoryAdapter;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    pgAdapter = new PostgresRepositoryAdapter(pool, "fleet-pg", "fleet-database");
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE objects`);
    memAdapter = new InMemoryRepositoryAdapter("fleet-notes", "fleet-notes-repo");
  });

  async function buildRuntime(): Promise<SemanticRuntime> {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());

    const widgetSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/fleet/Widget/1.0.0",
      title: "Widget",
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, priorityLabel: { type: "string" } },
      "x-relationships": {
        notes: {
          target: "fleet.Note",
          cardinality: "one-to-many",
          resolution: { dataSourceId: "fleet-notes", operation: "byForeignKey:widgetId" }
        }
      },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(widgetSchema, { name: "fleet.Widget", version: "1.0.0" });

    const noteSchema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/fleet/Note/1.0.0",
      title: "Note",
      type: "object",
      properties: { id: { type: "string" }, widgetId: { type: "string" }, text: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(noteSchema, { name: "fleet.Note", version: "1.0.0" });

    // Base: most of Widget's properties live in real Postgres.
    await registry.registerMapping({
      id: "map-widget-base",
      typeName: "fleet.Widget",
      target: "property",
      targetName: "*",
      dataSourceId: "fleet-pg",
      operation: "get",
      resolutionMode: "live"
    });
    // Override: priorityLabel lives in a completely different system (ADR-0023) —
    // the in-memory adapter, not Postgres.
    await registry.registerMapping({
      id: "map-widget-priority",
      typeName: "fleet.Widget",
      target: "property",
      targetName: "priorityLabel",
      dataSourceId: "fleet-notes",
      operation: "get",
      resolutionMode: "live"
    });
    await registry.registerMapping({
      id: "map-note-base",
      typeName: "fleet.Note",
      target: "property",
      targetName: "*",
      dataSourceId: "fleet-notes",
      operation: "get",
      resolutionMode: "live"
    });

    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    return new SemanticRuntime(registry, [pgAdapter, memAdapter], policyEngine);
  }

  it("resolves a relationship from a Postgres-backed Widget to an in-memory-backed Note (ADR-0006)", async () => {
    await pgAdapter.put("fleet.Widget", "widget-1", { id: "widget-1", name: "Real Widget" });
    memAdapter.seed("fleet.Note", [
      { objectId: "note-1", values: { id: "note-1", widgetId: "widget-1", text: "Check torque spec" } },
      { objectId: "note-2", values: { id: "note-2", widgetId: "widget-1", text: "Replace gasket" } },
      { objectId: "note-3", values: { id: "note-3", widgetId: "widget-2", text: "Different widget" } }
    ]);

    const runtime = await buildRuntime();
    const notes = await runtime.getRelationship("fleet.Widget", "widget-1", "notes", identity);
    expect(notes.map((n) => n.objectId).sort()).toEqual(["note-1", "note-2"]);
  });

  it("merges a Postgres base bundle with an in-memory-sourced property override into one getObject read (ADR-0023)", async () => {
    await pgAdapter.put("fleet.Widget", "widget-1", { id: "widget-1", name: "Real Widget" });
    memAdapter.seed("fleet.Widget", [{ objectId: "widget-1", values: { priorityLabel: "urgent" } }]);

    const runtime = await buildRuntime();
    const widget = await runtime.getObject("fleet.Widget", "widget-1", identity, { includeProvenance: true });

    expect(widget.values.name).toBe("Real Widget"); // from Postgres
    expect(widget.values.priorityLabel).toBe("urgent"); // from the in-memory override

    const priorityProvenance = widget.provenance?.find((p) => p.propertyPath === "priorityLabel");
    expect(priorityProvenance?.source.dataSourceId).toBe("fleet-notes"); // not fleet-pg
  });

  it("the override merge still works when the in-memory system has nothing for this object", async () => {
    await pgAdapter.put("fleet.Widget", "widget-2", { id: "widget-2", name: "No Priority Set" });
    // memAdapter deliberately seeded with nothing for widget-2.

    const runtime = await buildRuntime();
    const widget = await runtime.getObject("fleet.Widget", "widget-2", identity);
    expect(widget.values.name).toBe("No Priority Set");
    expect("priorityLabel" in widget.values).toBe(false);
  });

  it("query() merges the in-memory override into every Postgres-sourced item on the page", async () => {
    await pgAdapter.put("fleet.Widget", "w1", { id: "w1", name: "A" });
    await pgAdapter.put("fleet.Widget", "w2", { id: "w2", name: "B" });
    memAdapter.seed("fleet.Widget", [{ objectId: "w1", values: { priorityLabel: "low" } }]);

    const runtime = await buildRuntime();
    const result = await runtime.query({ type: "fleet.Widget" }, identity);
    const byId = new Map(result.items.map((i) => [i.objectId, i.values]));
    expect(byId.get("w1")?.priorityLabel).toBe("low");
    expect("priorityLabel" in (byId.get("w2") ?? {})).toBe(false);
  });
});
