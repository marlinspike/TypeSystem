import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../dist/bin.js");
const FIXTURES = path.join(__dirname, "fixtures");

async function typesys(...args: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, ...args]);
    return { code: 0, out: JSON.parse(stdout) as Record<string, unknown> };
  } catch (err) {
    const { code, stdout } = err as { code: number; stdout: string };
    return { code, out: JSON.parse(stdout) as Record<string, unknown> };
  }
}

/** `typesys generate-sdk` (ADR-0055): the typed client model from a YAML domain, and a CI gate against a stale one. */
describe("typesys generate-sdk", () => {
  it("writes the model, then --check passes until the model drifts", async () => {
    const out = path.join(await mkdtemp(path.join(tmpdir(), "typesys-cli-")), "model.ts");
    const common = [FIXTURES, "--bindings", path.join(FIXTURES, "bindings.mjs"), "--out", out, "--name", "FleetModel", "--json"];

    expect(await typesys("generate-sdk", ...common)).toEqual({ code: 0, out: { ok: true, out } });
    const code = await readFile(out, "utf8");
    expect(code).toContain("export interface FleetModel {");
    expect(code).toContain('"fleet.Vehicle": {');
    expect(code).toContain("utilizationRate: number;");
    expect(code).toContain('depot: { target: "core.Location"; many: false };');

    expect(await typesys("generate-sdk", ...common, "--check")).toEqual({ code: 0, out: { ok: true, out, upToDate: true } });
    await writeFile(out, code.replace("utilizationRate: number;", "utilizationRate: string;"));
    expect(await typesys("generate-sdk", ...common, "--check")).toEqual({ code: 1, out: { ok: false, out, upToDate: false } });
  }, 30_000);
});

/** `typesys describe` and `typesys diff` (ADR-0056): a model change gated in CI by how it lands on consumers. */
describe("typesys describe / diff / check-query", () => {
  it("passes an unchanged model, and fails a breaking change until the version moves", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "typesys-cli-"));
    const before = path.join(dir, "before.json");
    const after = path.join(dir, "after.json");
    expect(await typesys("describe", FIXTURES, "--bindings", path.join(FIXTURES, "bindings.mjs"), "--out", before, "--json")).toEqual({ code: 0, out: { ok: true, out: before } });
    expect(await typesys("diff", before, before, "--json")).toEqual({ code: 0, out: { ok: true, changes: [], underVersioned: [] } });

    const model = JSON.parse(await readFile(before, "utf8")) as { types: { name: string; version: string; properties: Record<string, unknown> }[] };
    const vehicle = model.types.find((t) => t.name === "fleet.Vehicle")!;
    delete vehicle.properties.plateNumber;
    await writeFile(after, JSON.stringify(model));
    const broken = await typesys("diff", before, after, "--json");
    expect(broken.code).toBe(1);
    expect(broken.out).toMatchObject({
      ok: false,
      changes: [{ impact: "breaking", subject: "fleet.Vehicle.plateNumber", change: "value removed" }],
      underVersioned: [{ subject: "fleet.Vehicle", needs: "major" }]
    });

    vehicle.version = "2.0.0";
    await writeFile(after, JSON.stringify(model));
    // Still a breaking change, so the gate still fails; the version finding is gone.
    expect((await typesys("diff", before, after, "--json")).out).toMatchObject({ ok: false, underVersioned: [] });
  }, 30_000);

  it("checks a query file against the model", async () => {
    const query = path.join(await mkdtemp(path.join(tmpdir(), "typesys-cli-")), "q.json");
    await writeFile(query, JSON.stringify({ type: "fleet.Vehicle", filter: { property: "fuelType", operator: "eq", value: "hydrogen" } }));
    const result = await typesys("check-query", FIXTURES, query, "--bindings", path.join(FIXTURES, "bindings.mjs"), "--json");
    expect(result).toMatchObject({ code: 1, out: { ok: false, valid: false, diagnostics: [{ code: "value-never-matches", path: "/filter/value" }] } });
  }, 30_000);
});
