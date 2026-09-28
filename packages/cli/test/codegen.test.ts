import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, registerDomain } from "@typesys/core";
import { registerYamlType } from "../src/yaml-loader.js";
import { generateModule } from "../src/codegen.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const VEHICLE_YAML = `
name: fleet.Vehicle
version: 1.0.0
title: Vehicle
description: A ground vehicle.
extends: core.Asset
traits: [Trackable, Maintainable]
properties:
  plateNumber: { type: string }
  fuelType: { type: string, enum: [gasoline, diesel, electric] }
  seats: { type: integer }
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

async function buildRegistry(): Promise<SemanticRegistry> {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerDomain(registry, coreManifest);
  await registerYamlType(registry, VEHICLE_YAML, {
    traitCatalog: coreTraits,
    computedImplementations: { computeUtilizationRate: async () => 1 }
  });
  return registry;
}

describe("generateModule", () => {
  it("emits an interface per Type, with extends for the base type and mixed-in trait interfaces", async () => {
    const registry = await buildRegistry();
    const code = await generateModule(registry);

    expect(code).toContain("export interface Vehicle extends Asset, Trackable, Maintainable");
    expect(code).toContain("plateNumber: string;");
    expect(code).toContain('fuelType?: "gasoline" | "diesel" | "electric";');
    expect(code).toContain("seats?: number;");
    expect(code).toContain("export interface Asset");
    expect(code).toContain("export interface Trackable");
    // Ownable/Geolocatable contribute only relationships, never used here, so must not appear as empty interfaces.
    expect(code).not.toContain("export interface Ownable");
    // Relationships/actions are documented, never emitted as fields.
    expect(code).toContain("Relationships (navigate via the runtime, not inline fields): depot.");
    expect(code).not.toContain("depot:");
  });

  it("produces output that is actually valid, compilable TypeScript", async () => {
    const registry = await buildRegistry();
    const code = await generateModule(registry);

    const dir = await mkdtemp(path.join(tmpdir(), "typesys-codegen-"));
    try {
      const file = path.join(dir, "generated.ts");
      await writeFile(file, code, "utf8");
      const tsc = path.join(REPO_ROOT, "node_modules/.bin/tsc");
      await expect(
        execFileAsync(
          tsc,
          ["--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "generated.ts"],
          { cwd: dir } // run from the tmpdir — a tsconfig.json in cwd otherwise makes tsc reject explicit file args (TS5112)
        )
      ).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
