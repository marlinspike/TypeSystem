import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, registerDomain } from "@typesys/core";
import { loadTypeYaml, registerYamlType, registerYamlTypesFromDirectory } from "../src/yaml-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

const VEHICLE_YAML = `
name: fleet.Vehicle
version: 1.0.0
title: Vehicle
extends: core.Asset
traits: [Trackable, Maintainable]
properties:
  plateNumber: { type: string }
required: [plateNumber]
relationships:
  depot:
    target: core.Location
    cardinality: one-to-one
    resolution: { dataSourceId: fleet-repo, operation: "byOwnField:depotId" }
computed:
  utilizationRate:
    dependsOn: [maintenanceStatus]
    binding: computeUtilizationRate
policy:
  objectPolicy: fleet.read-vehicle
`;

async function freshRegistryWithCore(): Promise<SemanticRegistry> {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerDomain(registry, coreManifest);
  return registry;
}

describe("loadTypeYaml", () => {
  it("compiles a YAML type document into a SemanticTypeSchema + RegisterTypeOptions", () => {
    const { schema, options } = loadTypeYaml(VEHICLE_YAML, { traitCatalog: coreTraits });

    expect(schema.$id).toBe("https://typesys.dev/types/fleet/Vehicle/1.0.0");
    expect(schema.properties?.plateNumber).toEqual({ type: "string" });
    expect(schema.required).toEqual(["plateNumber"]);
    expect(schema["x-relationships"]?.depot?.target).toBe("core.Location");
    expect(schema["x-policy"]?.objectPolicy).toBe("fleet.read-vehicle");

    expect(options.name).toBe("fleet.Vehicle");
    expect(options.version).toBe("1.0.0");
    expect(options.extends).toBe("core.Asset");
    expect(options.traits?.map((t) => t.name)).toEqual(["Trackable", "Maintainable"]);
  });

  it("throws a clear error for an unknown trait name", () => {
    const yamlWithBadTrait = VEHICLE_YAML.replace("[Trackable, Maintainable]", "[NotARealTrait]");
    expect(() => loadTypeYaml(yamlWithBadTrait, { traitCatalog: coreTraits })).toThrow(/unknown trait "NotARealTrait"/i);
  });

  it("throws a clear error when required fields are missing", () => {
    expect(() => loadTypeYaml("title: Nameless\nversion: 1.0.0")).toThrow(/missing required field "name"/i);
    expect(() => loadTypeYaml("name: fleet.X")).toThrow(/missing required field "version"/i);
  });
});

describe("registerYamlType", () => {
  it("registers end-to-end: extends + traits compose exactly like a TS-authored type would", async () => {
    const registry = await freshRegistryWithCore();
    const computeUtilizationRate = async () => 0.75;

    const typeDef = await registerYamlType(registry, VEHICLE_YAML, {
      traitCatalog: coreTraits,
      computedImplementations: { computeUtilizationRate }
    });

    expect(typeDef.name).toBe("fleet.Vehicle");
    expect(typeDef.extends).toBe("core.Asset");
    expect(typeDef.traits).toEqual(["Trackable", "Maintainable"]);
    expect(typeDef.relationships.map((r) => r.name)).toContain("depot");
    expect(typeDef.computedProperties[0]?.binding).toBe("computeUtilizationRate");

    // Structural properties inherited from core.Asset via `allOf` — proves composition
    // actually happened, not just that options were passed through.
    const fetched = await registry.getType("fleet.Vehicle");
    expect(fetched?.schema.allOf?.length).toBeGreaterThan(0);
  });
});

describe("registerYamlTypesFromDirectory", () => {
  it("loads every .yaml file in a directory, alphabetically", async () => {
    const registry = await freshRegistryWithCore();
    const results = await registerYamlTypesFromDirectory(registry, FIXTURES_DIR, {
      traitCatalog: coreTraits,
      computedImplementations: { computeUtilizationRate: async () => 1 }
    });

    expect(results.map((t) => t.name)).toEqual(["fleet.Vehicle"]);
    expect(await registry.getType("fleet.Vehicle")).toBeDefined();
  });
});
