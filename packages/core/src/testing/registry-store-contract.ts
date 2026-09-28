import type { RegistryStore } from "../registry/registry-store.js";
import type { TypeDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { AuditEvent } from "../audit/audit-log.js";

/**
 * A framework-agnostic contract test suite every `RegistryStore`
 * implementation must pass identically (see ADR-0015). Deliberately takes
 * the test framework's `describe`/`it`/`expect`/`beforeEach` as parameters
 * rather than importing `vitest` directly, so `@typesys/core`'s runtime
 * package never depends on a test framework — only test files that call
 * this function do.
 *
 * Uses plain-data fixtures only (no `compute`/`check` closures): proving
 * that a store round-trips *data* identically is this suite's whole job.
 * Rehydrating behavior through a `BindingRegistry` is backend-specific
 * (only a durable store needs it) and is tested separately, alongside
 * whatever else is unique to that backend (e.g.
 * `packages/registry-store-postgres/test/postgres-registry-store.test.ts`).
 */
export interface ContractTestHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: (value: unknown) => any;
  beforeEach: (fn: () => Promise<void> | void) => void;
}

function widgetType(version: string, extra?: Partial<TypeDefinition>): TypeDefinition {
  return {
    id: `widget-${version}`,
    name: "contract.Widget",
    version,
    schema: {
      $id: `https://typesys.dev/types/contract/Widget/${version}`,
      title: "Widget",
      type: "object",
      properties: { color: { type: "string" } }
    },
    relationships: [],
    actionNames: [],
    computedProperties: [],
    ...extra
  };
}

function widgetRelationship(sourceType: string, targetType: string, version: string): RelationshipDefinition {
  return {
    id: `rel-${sourceType}-${targetType}-${version}`,
    name: "owner",
    sourceType,
    targetType,
    cardinality: "one-to-one",
    resolution: { dataSourceId: "contract-ds", operation: "get" },
    version
  };
}

function noopAction(name: string, version: string): ActionDefinition {
  return {
    id: `action-${name}-${version}`,
    name,
    description: "A contract-test action",
    applicableTypes: ["contract.Widget"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authorizationPolicy: "allow-all",
    implementation: { dataSourceId: "contract-ds", operation: "noop" },
    sideEffects: "none",
    idempotency: "none",
    auditRequired: false,
    version
  };
}

function auditEvent(id: string, timestamp: string): AuditEvent {
  return {
    id,
    timestamp,
    subjectId: "contract-subject",
    action: "read",
    resource: { typeName: "contract.Widget" },
    decision: "allow"
  };
}

export function runRegistryStoreContractTests(
  harness: ContractTestHarness,
  label: string,
  makeStore: () => Promise<RegistryStore>
): void {
  const { describe, it, expect, beforeEach } = harness;

  describe(`RegistryStore contract — ${label}`, () => {
    let store: RegistryStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    it("types: put/get round-trips, versions coexist, latest is the default", async () => {
      await store.putType(widgetType("1.0.0"));
      await store.putType(widgetType("2.0.0"));

      const latest = await store.getType("contract.Widget");
      expect(latest?.version).toBe("2.0.0");

      const pinned = await store.getType("contract.Widget", "1.0.0");
      expect(pinned?.version).toBe("1.0.0");

      const range = await store.getType("contract.Widget", "^1.0.0");
      expect(range?.version).toBe("1.0.0");

      const versions = await store.listTypeVersions("contract.Widget");
      expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "2.0.0"]);

      const missing = await store.getType("contract.NoSuchType");
      expect(missing).toBeUndefined();
    });

    it("types: putType with the same (name, version) replaces, not duplicates", async () => {
      await store.putType(widgetType("1.0.0", { description: "first" }));
      await store.putType(widgetType("1.0.0", { description: "second" }));

      const versions = await store.listTypeVersions("contract.Widget");
      expect(versions).toHaveLength(1);
      expect(versions[0]?.description).toBe("second");
    });

    it("types: listTypes returns one entry per name, at its latest version", async () => {
      await store.putType(widgetType("1.0.0"));
      await store.putType(widgetType("1.1.0"));
      await store.putType({ ...widgetType("1.0.0"), id: "gadget-1", name: "contract.Gadget" });

      const types = await store.listTypes();
      const byName = new Map(types.map((t) => [t.name, t]));
      expect(byName.size).toBe(2);
      expect(byName.get("contract.Widget")?.version).toBe("1.1.0");
    });

    it("relationships: putRelationship upserts by (sourceType, name) — re-registering replaces, never accumulates", async () => {
      await store.putRelationship(widgetRelationship("contract.Widget", "core.Party", "1.0.0"));
      await store.putRelationship(widgetRelationship("contract.Widget", "core.Organization", "2.0.0"));

      const rels = await store.listRelationships("contract.Widget");
      expect(rels).toHaveLength(1);
      expect(rels[0]?.targetType).toBe("core.Organization");

      expect(await store.listRelationships("contract.NoSuchType")).toEqual([]);
    });

    it("actions: put/get round-trips and resolves versions the same way types do", async () => {
      await store.putAction(noopAction("TestAction", "1.0.0"));
      await store.putAction(noopAction("TestAction", "2.0.0"));

      expect((await store.getAction("TestAction"))?.version).toBe("2.0.0");
      expect((await store.getAction("TestAction", "1.0.0"))?.version).toBe("1.0.0");
      expect(await store.getAction("NoSuchAction")).toBeUndefined();

      const all = await store.listActions();
      expect(all.map((a) => a.name)).toContain("TestAction");
    });

    it("data sources: put/get round-trips, including a nested config object", async () => {
      await store.putDataSource({ id: "ds-1", name: "Contract DS", kind: "in-memory", config: { nested: { value: 42 } } });
      const ds = await store.getDataSource("ds-1");
      expect(ds).toMatchObject({ name: "Contract DS", kind: "in-memory" });
      expect(ds?.config).toEqual({ nested: { value: 42 } });
      expect(await store.getDataSource("no-such-ds")).toBeUndefined();
    });

    it("mappings: multiple mappings for the same type coexist (wildcard + specific)", async () => {
      await store.putDataSource({ id: "ds-1", name: "DS1", kind: "in-memory" });
      await store.putDataSource({ id: "ds-2", name: "DS2", kind: "in-memory" });
      await store.putMapping({
        id: "map-wild",
        typeName: "contract.Widget",
        target: "property",
        targetName: "*",
        dataSourceId: "ds-1",
        operation: "get",
        resolutionMode: "live"
      });
      await store.putMapping({
        id: "map-specific",
        typeName: "contract.Widget",
        target: "property",
        targetName: "color",
        dataSourceId: "ds-2",
        operation: "getColor",
        resolutionMode: "live"
      });

      const mappings = await store.listMappings("contract.Widget");
      expect(mappings).toHaveLength(2);
      expect(await store.listMappings("contract.NoSuchType")).toEqual([]);
    });

    it("mappings: putMapping with the same id replaces the row", async () => {
      await store.putDataSource({ id: "ds-1", name: "DS1", kind: "in-memory" });
      await store.putDataSource({ id: "ds-2", name: "DS2", kind: "in-memory" });
      await store.putMapping({
        id: "map-1",
        typeName: "contract.Widget",
        target: "property",
        targetName: "*",
        dataSourceId: "ds-1",
        operation: "get",
        resolutionMode: "live"
      });
      await store.putMapping({
        id: "map-1",
        typeName: "contract.Widget",
        target: "property",
        targetName: "*",
        dataSourceId: "ds-2",
        operation: "getV2",
        resolutionMode: "materialized"
      });

      const mappings = await store.listMappings("contract.Widget");
      expect(mappings).toHaveLength(1);
      expect(mappings[0]?.dataSourceId).toBe("ds-2");
    });

    it("audit events: append-only, newest-first, bounded, cursor-paginated", async () => {
      for (let i = 0; i < 5; i++) {
        await store.appendAuditEvent(auditEvent(`evt-${i}`, new Date(2026, 0, 1, 0, 0, i).toISOString()));
      }

      const firstPage = await store.listAuditEvents({ limit: 2 });
      expect(firstPage.items.map((e) => e.id)).toEqual(["evt-4", "evt-3"]);
      expect(firstPage.nextCursor).toBe("evt-3");

      const secondPage = await store.listAuditEvents({ limit: 2, before: firstPage.nextCursor });
      expect(secondPage.items.map((e) => e.id)).toEqual(["evt-2", "evt-1"]);

      const defaultPage = await store.listAuditEvents();
      expect(defaultPage.items.length).toBeGreaterThan(0);
    });
  });
}
