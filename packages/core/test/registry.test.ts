import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { registerDomain } from "../src/registry/manifest.js";
import { coreManifest } from "../src/base/manifest.js";
import type { ActionDefinition } from "../src/model/action.js";

describe("SemanticRegistry", () => {
  it("lists all registered types at their latest version", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const types = await registry.listTypes();
    const names = types.map((t) => t.name).sort();
    expect(names).toEqual(["core.Asset", "core.Event", "core.Location", "core.Organization", "core.Party", "core.Person"]);
  });

  it("registers and retrieves an ActionDefinition", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const action: ActionDefinition = {
      id: "test-action-1",
      name: "TestAction",
      description: "A test action",
      applicableTypes: ["core.Asset"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      authorizationPolicy: "allow-all",
      implementation: { dataSourceId: "test-ds", operation: "noop" },
      sideEffects: "none",
      idempotency: "none",
      auditRequired: false,
      version: "1.0.0"
    };
    await registry.registerAction(action);

    const found = await registry.getAction("TestAction");
    expect(found?.description).toBe("A test action");
    expect(await registry.listActions()).toHaveLength(1);
  });

  it("data sources and mappings round-trip through the registry", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerDataSource({ id: "ds-1", name: "Test DS", kind: "in-memory" });
    expect(await registry.getDataSource("ds-1")).toMatchObject({ name: "Test DS" });

    await registry.registerMapping({
      id: "map-1",
      typeName: "core.Asset",
      target: "property",
      targetName: "*",
      dataSourceId: "ds-1",
      operation: "getAll",
      resolutionMode: "live"
    });
    const mappings = await registry.listMappings("core.Asset");
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.dataSourceId).toBe("ds-1");
  });

  it("re-registering a type at a new version replaces its relationships rather than accumulating them (ADR-0015)", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());

    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Widget/1.0.0",
        title: "Widget",
        type: "object",
        "x-relationships": {
          owner: {
            target: "core.Party",
            cardinality: "one-to-one",
            resolution: { dataSourceId: "ds", operation: "get" }
          }
        }
      },
      { name: "test.Widget", version: "1.0.0" }
    );
    expect(await registry.listRelationships("test.Widget")).toHaveLength(1);

    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Widget/2.0.0",
        title: "Widget",
        type: "object",
        "x-relationships": {
          owner: {
            target: "core.Organization", // target changed in v2
            cardinality: "one-to-one",
            resolution: { dataSourceId: "ds", operation: "get" }
          }
        }
      },
      { name: "test.Widget", version: "2.0.0" }
    );

    const rels = await registry.listRelationships("test.Widget");
    expect(rels).toHaveLength(1); // not 2 — the stale v1.0.0 "owner" row must not linger
    expect(rels[0]?.targetType).toBe("core.Organization");
    expect(rels[0]?.version).toBe("2.0.0");
  });

  it("audit events are queryable newest-first, bounded, and cursor-paginated", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    for (let i = 0; i < 5; i++) {
      await registry.appendAuditEvent({
        id: `evt-${i}`,
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        subjectId: "user-1",
        action: "read",
        resource: { typeName: "test.Widget" },
        decision: "allow"
      });
    }

    const firstPage = await registry.listAuditEvents({ limit: 2 });
    expect(firstPage.items.map((e) => e.id)).toEqual(["evt-4", "evt-3"]);
    expect(firstPage.nextCursor).toBe("evt-3");

    const secondPage = await registry.listAuditEvents({ limit: 2, before: firstPage.nextCursor });
    expect(secondPage.items.map((e) => e.id)).toEqual(["evt-2", "evt-1"]);

    const all = await registry.listAuditEvents({ limit: 100 });
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeUndefined();
  });
});
