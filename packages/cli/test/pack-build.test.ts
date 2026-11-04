import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { verifyPack, type PackArchive } from "@typesys/packs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const BIN = path.resolve(__dirname, "../dist/bin.js");
const run = promisify(execFile);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "typesys-cli-"));
  dirs.push(d);
  return d;
};

async function typesys(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const { code, stdout, stderr } = err as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

/** ADR-0115: YAML Types as a pack a deployment lists. */
describe("typesys pack build", () => {
  it("builds a verifiable pack from typesys init's YAML, read from one declared source, requiring core", async () => {
    const dir = temp();
    expect((await typesys("init", path.join(dir, "fleet"), "--name", "fleet")).code).toBe(0);
    const out = path.join(dir, "fleet-1.0.0.typesys-pack.json");
    const r = await typesys("pack", "build", path.join(dir, "fleet"), "--name", "fleet", "--version", "1.0.0", "--out", out, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, name: "fleet", version: "1.0.0", types: ["fleet.Widget"], source: "fleet-db" });
    const pack = JSON.parse(readFileSync(out, "utf8")) as PackArchive;
    expect(verifyPack(pack)).toEqual([]);
    expect(pack.requires).toEqual({ core: "^1.0.0" });
    expect(pack.contents.dataSources).toEqual([{ id: "fleet-db", name: "fleet-db", kind: "postgres" }]);
    expect(pack.contents.mappings.map((m) => [m.typeName, m.dataSourceId, m.targetName])).toEqual([["fleet.Widget", "fleet-db", "*"]]);
    expect(pack.requirements.policies).toEqual(["fleet.read-widget"]);
  });

  it("the pack is served by a deployment that declares its table, without any code", async () => {
    const dir = temp();
    await typesys("init", path.join(dir, "fleet"), "--name", "fleet");
    mkdirSync(path.join(dir, "packs"));
    await typesys("pack", "build", path.join(dir, "fleet"), "--name", "fleet", "--version", "1.0.0", "--out", path.join(dir, "packs/fleet-1.0.0.typesys-pack.json"));
    cpSync(path.join(ROOT, "packs/core-1.0.0.typesys-pack.json"), path.join(dir, "packs/core-1.0.0.typesys-pack.json"));
    const file = path.join(dir, "fleet.deployment.json");
    writeFileSync(
      file,
      JSON.stringify({
        format: "typesys.deployment/1",
        name: "fleet",
        demo: true,
        packs: [{ name: "core", version: "1.0.0" }, { name: "fleet", version: "1.0.0" }],
        sources: { "fleet-db": { kind: "postgres", system: "Fleet DB", url: { $secret: "FLEET_URL" }, types: { "fleet.Widget": { table: "widgets", id: "id", columns: { id: "id", name: "name", status: "status" } } } } },
        policies: { "fleet.read-widget": { role: ["reader"] } },
        identity: { kind: "tokens", tokens: { "t-reader": "reader" } },
        personas: { reader: { subjectId: "r", roles: ["reader"], attributes: {} } }
      })
    );
    const { buildHost, loadDeployment, overlayEnvironment, emptyEnvironment } = await import("@typesys/host");
    const { deployment, packs } = await loadDeployment(file);
    const host = await buildHost(deployment, { packs, env: overlayEnvironment({ FLEET_URL: "postgresql://nobody@127.0.0.1:1/none" }, emptyEnvironment), state: "memory" });
    expect(host.packs.map((p) => p.name)).toEqual(["core", "fleet"]);
    await host.close();
  });

  it("names what is missing, and a YAML file that does not register, before writing anything", async () => {
    const dir = temp();
    expect((await typesys("pack", "build", dir, "--name", "x", "--version", "1.0.0")).stderr).toContain("pack build needs --name, --version and --out");
    writeFileSync(path.join(dir, "00-bad.yaml"), "name: x.Bad\nversion: 1.0.0\ntraits: [Nope]\n");
    const r = await typesys("pack", "build", dir, "--name", "x", "--version", "1.0.0", "--out", path.join(dir, "out.json"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown trait "Nope"/);
    const empty = temp();
    expect((await typesys("pack", "build", empty, "--name", "x", "--version", "1.0.0", "--out", path.join(empty, "o.json"))).stderr).toContain("has no .yaml or .yml Types");
  });
});

/** Every command npm links is a committed shim, so a fresh clone has them before anything is built. */
describe("the command shims", () => {
  const shims = [
    ["cli", "typesys"],
    ["compiler", "typesys-app"],
    ["compiler", "typesys-app-mcp"],
    ["engineer", "typesys-engineer"],
    ["engineer", "typesys-engineer-mcp"],
    ["host", "typesys-host"],
    ["onboard", "typesys-onboard"],
    ["onboard", "typesys-onboard-mcp"],
    ["showcase", "typesys-showcase"]
  ] as const;

  it("every package's bin is a committed shim, shipped with the package", () => {
    for (const [pkg, name] of shims) {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8")) as { bin: Record<string, string>; files?: string[] };
      expect(manifest.bin[name]).toBe(`./bin/${name}.js`);
      if (manifest.files) expect(manifest.files).toContain("bin");
      expect(readFileSync(path.join(ROOT, "packages", pkg, "bin", `${name}.js`), "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
    }
  });

  it("runs the built command, and says to build when there is nothing built", async () => {
    const built = await run(process.execPath, [path.join(ROOT, "packages/cli/bin/typesys.js"), "--help"]).then((r) => r.stdout);
    expect(built).toContain("typesys init <dir>");
    const dir = temp();
    mkdirSync(path.join(dir, "bin"));
    cpSync(path.join(ROOT, "packages/cli/bin/typesys.js"), path.join(dir, "bin/typesys.js"));
    const r = await run(process.execPath, [path.join(dir, "bin/typesys.js"), "--help"]).catch((e: unknown) => e as { code: number; stderr: string });
    expect((r as { code: number }).code).toBe(1);
    expect((r as { stderr: string }).stderr).toContain("typesys: this package is not built yet. Run `npm run build` at the repository root, then try again.");
  });

  it("typesys-host through its shim serves as the server does (its main is exported for the shim to call)", async () => {
    const r = await run(process.execPath, [path.join(ROOT, "packages/host/bin/typesys-host.js")]).catch((e: unknown) => e as { code: number; stderr: string });
    expect((r as { code: number }).code).toBe(2);
    expect((r as { stderr: string }).stderr).toContain("Usage: typesys-host <deployment.json>");
  });
});
