import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { SemanticRegistry, InMemoryRegistryStore, coreManifest, coreTraits, registerDomain } from "@typesys/core";
import { scaffoldDomain } from "../src/scaffold.js";
import { registerYamlTypesFromDirectory } from "../src/yaml-loader.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("scaffoldDomain", () => {
  it("creates an example Type, a bindings stub, and a README", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "typesys-init-"));
    const target = path.join(tmpDir, "fleet");

    const result = await scaffoldDomain(target, "fleet");

    expect(result.createdFiles).toHaveLength(3);
    const readme = await readFile(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("fleet");
    expect(readme).toContain("typesys validate");
  });

  it("the scaffolded YAML actually registers and validates end-to-end", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "typesys-init-"));
    const target = path.join(tmpDir, "fleet");
    await scaffoldDomain(target, "fleet");

    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);
    const registered = await registerYamlTypesFromDirectory(registry, target, { traitCatalog: coreTraits });

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("fleet.Widget");
    expect(registered[0]?.extends).toBe("core.Asset");
  });

  it("refuses to scaffold into an existing directory without --force", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "typesys-init-"));
    const target = path.join(tmpDir, "fleet");
    await scaffoldDomain(target, "fleet");

    await expect(scaffoldDomain(target, "fleet")).rejects.toThrow(/already exists/);
    await expect(scaffoldDomain(target, "fleet", true)).resolves.toBeDefined();
  });
});
