import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import {
  runRegistryStoreContractTests,
  MissingBindingError,
  type BindingRegistry,
  type ComputeContext,
  type ActionContext,
  type Identity
} from "@typesys/core";
import { PostgresRegistryStore } from "../src/postgres-registry-store.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

const testIdentity: Identity = { subjectId: "test-subject", roles: [], attributes: {} };

describe.skipIf(!hasDb)("PostgresRegistryStore", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function truncateAll(): Promise<void> {
    // TRUNCATE does not fire the row-level BEFORE DELETE trigger on audit_events
    // (it's a statement-level operation) — safe here, but production operators
    // must never run this against a real environment (see README.md).
    await pool.query(`TRUNCATE types, relationships, actions, data_sources, mappings, audit_events`);
  }

  // The shared contract suite (packages/core/src/testing/registry-store-contract.ts):
  // proves this backend behaves identically to InMemoryRegistryStore for pure data.
  runRegistryStoreContractTests({ describe, it, expect, beforeEach }, "PostgresRegistryStore", async () => {
    await truncateAll();
    return new PostgresRegistryStore(pool);
  });

  // What only a durable store needs to prove: behavior actually survives a
  // write-then-read round trip through a BindingRegistry (see ADR-0015).
  describe("Postgres-specific: binding rehydration and durability", () => {
    beforeEach(async () => {
      await truncateAll();
    });

    it("round-trips a computed property's compute function through a BindingRegistry", async () => {
      const bindings: BindingRegistry = {
        computed: {
          double: async (ctx: ComputeContext) => {
            const n = await ctx.getProperty("n");
            return (n as number) * 2;
          }
        },
        preconditions: {}
      };
      const store = new PostgresRegistryStore(pool, bindings);

      await store.putType({
        id: "t-doubler",
        name: "test.Doubler",
        version: "1.0.0",
        schema: { $id: "https://typesys.dev/types/test/Doubler/1.0.0", title: "Doubler", type: "object" },
        relationships: [],
        actionNames: [],
        computedProperties: [
          { name: "doubled", dependsOn: ["n"], resolutionMode: "live", binding: "double", compute: async () => 0 }
        ]
      });

      const readBack = await store.getType("test.Doubler");
      expect(readBack?.computedProperties).toHaveLength(1);

      const ctx: ComputeContext = {
        identity: testIdentity,
        objectId: "obj-1",
        typeName: "test.Doubler",
        getAdapter: () => {
          throw new Error("not exercised by this test");
        },
        getProperty: async () => 21
      };
      const result = await readBack!.computedProperties[0]!.compute(ctx);
      expect(result).toBe(42); // proves the REAL rehydrated function ran, not a stub
    });

    it("throws MissingBindingError when a computed property's binding was never supplied", async () => {
      const store = new PostgresRegistryStore(pool); // empty BindingRegistry
      await store.putType({
        id: "t-unbound",
        name: "test.Unbound",
        version: "1.0.0",
        schema: { $id: "https://typesys.dev/types/test/Unbound/1.0.0", title: "Unbound", type: "object" },
        relationships: [],
        actionNames: [],
        computedProperties: [
          { name: "x", dependsOn: [], resolutionMode: "live", binding: "notRegisteredAnywhere", compute: async () => 0 }
        ]
      });

      await expect(store.getType("test.Unbound")).rejects.toBeInstanceOf(MissingBindingError);
    });

    it("putType fails loudly (not silently) if a computed property has no binding to persist", async () => {
      const store = new PostgresRegistryStore(pool);
      await expect(
        store.putType({
          id: "t-nobinding",
          name: "test.NoBinding",
          version: "1.0.0",
          schema: { $id: "https://typesys.dev/types/test/NoBinding/1.0.0", title: "NoBinding", type: "object" },
          relationships: [],
          actionNames: [],
          computedProperties: [{ name: "x", dependsOn: [], resolutionMode: "live", binding: "", compute: async () => 0 }]
        })
      ).rejects.toThrow(/no binding/i);
    });

    it("round-trips a precondition's check function through a BindingRegistry", async () => {
      const bindings: BindingRegistry = {
        computed: {},
        preconditions: { alwaysTrue: async () => true }
      };
      const store = new PostgresRegistryStore(pool, bindings);

      await store.putAction({
        id: "a-test",
        name: "TestAction",
        version: "1.0.0",
        description: "A test action",
        applicableTypes: ["test.Widget"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        authorizationPolicy: "allow-all",
        preconditions: [{ description: "always true", bindingId: "alwaysTrue", check: async () => false }],
        implementation: { dataSourceId: "ds", operation: "noop" },
        sideEffects: "none",
        idempotency: "none",
        auditRequired: false
      });

      const readBack = await store.getAction("TestAction");
      const ctx: ActionContext = {
        identity: testIdentity,
        input: {},
        getAdapter: () => {
          throw new Error("not exercised by this test");
        },
        getProperty: async () => undefined
      };
      const result = await readBack!.preconditions![0]!.check(ctx);
      expect(result).toBe(true); // the REAL rehydrated function ran, not the stub `false` we wrote
    });

    it("throws MissingBindingError when a precondition's bindingId was never supplied", async () => {
      const store = new PostgresRegistryStore(pool);
      await store.putAction({
        id: "a-unbound",
        name: "UnboundAction",
        version: "1.0.0",
        description: "x",
        applicableTypes: ["test.Widget"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        authorizationPolicy: "allow-all",
        preconditions: [{ description: "x", bindingId: "notRegistered", check: async () => true }],
        implementation: { dataSourceId: "ds", operation: "noop" },
        sideEffects: "none",
        idempotency: "none",
        auditRequired: false
      });

      await expect(store.getAction("UnboundAction")).rejects.toBeInstanceOf(MissingBindingError);
    });

    it("audit_events rejects UPDATE and DELETE at the database level, regardless of application code", async () => {
      const store = new PostgresRegistryStore(pool);
      await store.appendAuditEvent({
        id: "evt-immutable",
        timestamp: new Date().toISOString(),
        subjectId: "s",
        action: "read",
        resource: { typeName: "test.Widget" },
        decision: "allow"
      });

      await expect(pool.query(`UPDATE audit_events SET decision = 'deny' WHERE id = 'evt-immutable'`)).rejects.toThrow(
        /append-only/
      );
      await expect(pool.query(`DELETE FROM audit_events WHERE id = 'evt-immutable'`)).rejects.toThrow(/append-only/);
    });

    it("migrations are safely re-runnable against an already-migrated database", async () => {
      const result = await runMigrations(pool);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toContain("0001_init.sql");
    });
  });
});
