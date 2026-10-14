import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../dist/bin.js");
const airforce = path.resolve(__dirname, "../../../packs/airforce-1.0.0.typesys-pack.json");

async function run(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, ...args]);
    return { code: 0, stdout };
  } catch (err) {
    const { code, stdout } = err as { code: number; stdout: string };
    return { code, stdout };
  }
}

/** Adversarial review of `typesys pack verify --revoke` (ADR-0069). */
describe("pack verify --revoke adversarial", () => {
  it("a withdrawn digest written in upper case, or without its sha256: prefix, still refuses the build (or is rejected as malformed)", async () => {
    const { digest } = JSON.parse(await readFile(airforce, "utf8")) as { digest: string };
    const hex = digest.slice("sha256:".length);
    for (const spelled of [`SHA256:${hex}`, `sha256:${hex.toUpperCase()}`, hex]) {
      const r = await run("pack", "verify", airforce, "--revoke", spelled, "--json");
      expect(r.code, `--revoke ${spelled}\n${r.stdout}`).not.toBe(0);
    }
  });
});
