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
});
