import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { registerDomain } from "../src/registry/manifest.js";
import { coreManifest, TrackableTrait, MaintainableTrait, GeolocatableTrait, OwnableTrait } from "../src/base/manifest.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

describe("extends + trait composition", () => {
  it("merges a single-level extends and multiple traits into one flattened TypeDefinition", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Widget/1.0.0",
      title: "Widget",
      type: "object",
      properties: { serialNumber: { type: "string" } },
      required: ["serialNumber"]
    };

    const widget = await registry.registerType(schema, {
      name: "test.Widget",
      version: "1.0.0",
      extends: "core.Asset",
      traits: [TrackableTrait, MaintainableTrait, GeolocatableTrait, OwnableTrait]
    });

    expect(widget.extends).toBe("core.Asset");
    expect(widget.traits).toEqual(["Trackable", "Maintainable", "Geolocatable", "Ownable"]);

    // Trait-contributed relationships are materialized into the flattened definition.
    const relNames = widget.relationships.map((r) => r.name).sort();
    expect(relNames).toEqual(["location", "owner"]);

    const ownerRel = widget.relationships.find((r) => r.name === "owner");
    expect(ownerRel?.targetType).toBe("core.Party");
    expect(ownerRel?.cardinality).toBe("one-to-one");

    // The composed JSON Schema structurally validates base + trait + own properties together.
    const composedProps = widget.schema.allOf?.length;
    expect(composedProps).toBeGreaterThan(0);
  });

  it("lets a subtype's own x-relationships override a trait-contributed relationship of the same name", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/CustomOwned/1.0.0",
      title: "CustomOwned",
      type: "object",
      "x-relationships": {
        owner: {
          target: "core.Organization",
          cardinality: "one-to-one",
          resolution: { dataSourceId: "test-ds", operation: "getOwner" }
        }
      }
    };

    const def = await registry.registerType(schema, {
      name: "test.CustomOwned",
      version: "1.0.0",
      traits: [OwnableTrait]
    });

    const ownerRel = def.relationships.find((r) => r.name === "owner");
    expect(ownerRel?.targetType).toBe("core.Organization");
    expect(ownerRel?.resolution.dataSourceId).toBe("test-ds");
  });

  it("registering a type that extends an unregistered base type throws", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Orphan/1.0.0",
      title: "Orphan",
      type: "object"
    };
    await expect(
      registry.registerType(schema, { name: "test.Orphan", version: "1.0.0", extends: "core.NoSuchType" })
    ).rejects.toThrow(/Cannot extend unknown type/);
  });
});
