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
