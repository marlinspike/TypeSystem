import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

describe("Schema versioning and aliasing", () => {
  it("keeps multiple versions of a type retrievable, and resolves version ranges", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());

    const v1: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Widget/1.0.0",
      title: "Widget",
      type: "object",
      properties: { color: { type: "string" } }
    };
    await registry.registerType(v1, { name: "test.Widget", version: "1.0.0" });

    const v2: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Widget/2.0.0",
      title: "Widget",
      type: "object",
      properties: { color: { type: "string" }, weightKg: { type: "number" } }
    };
    await registry.registerType(v2, { name: "test.Widget", version: "2.0.0" });

    const versions = await registry.listTypeVersions("test.Widget");
    expect(versions.map((v) => v.version).sort()).toEqual(["1.0.0", "2.0.0"]);

    const latest = await registry.getType("test.Widget");
    expect(latest?.version).toBe("2.0.0");

    const pinned = await registry.getType("test.Widget", "^1.0.0");
    expect(pinned?.version).toBe("1.0.0");
  });

  it("exercises a property rename through a deprecation + alias transition window", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());

    const original: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Renamed/1.0.0",
      title: "Renamed",
      type: "object",
      properties: { legacyStatus: { type: "string" } }
    };
    await registry.registerType(original, { name: "test.Renamed", version: "1.0.0" });

    const renamed: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Renamed/2.0.0",
      title: "Renamed",
      type: "object",
      properties: { status: { type: "string" } }
    };
    const def = await registry.registerType(renamed, {
      name: "test.Renamed",
      version: "2.0.0",
      aliases: { legacyStatus: "status" },
      deprecated: { since: "2.0.0" }
    });

    // Old consumers referencing "legacyStatus" still resolve to the current property name.
    expect(registry.resolveAlias(def, "legacyStatus")).toBe("status");
    expect(registry.resolveAlias(def, "status")).toBe("status");
    expect(def.deprecated?.since).toBe("2.0.0");

    // The old version remains retrievable — existing consumers pinned to it don't break.
    const oldVersion = await registry.getType("test.Renamed", "1.0.0");
    expect(oldVersion?.schema.properties?.legacyStatus).toBeDefined();
  });
});
