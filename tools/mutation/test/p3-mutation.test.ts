import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Independent review (P3) of `npm run mutation` (ADR-0070). The ADR says the
 * harness "restores the file, also on an error or a signal". The run is
 * started the way a person starts it (`npm run mutation`, i.e. through tsx)
 * in a scratch copy of the repository, so a failure here never leaves this
 * checkout mutated. The copy carries a one-entry catalog (a mutation of
 * core's canonical JSON); the signal lands the moment the forced rebuild
 * has written the mutated output. tsx relays the signal to the script and,
 * since the script is blocked in spawnSync and cannot acknowledge it within
 * 30 ms, SIGKILLs it, so its restore handler never runs.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const work = mkdtempSync(path.join(tmpdir(), "p3-mutation-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const TARGET = "packages/core/src/model/canonical.ts";
const BUILT = "packages/core/dist/model/canonical.js";
const FIND = "(a < b ? -1 : a > b ? 1 : 0)";
const REPLACE = "(a < b ? 1 : a > b ? -1 : 0)";

function scratchRepository(): void {
  execSync(`git -C ${JSON.stringify(ROOT)} archive HEAD | tar -x -C ${JSON.stringify(work)}`);
  symlinkSync(path.join(ROOT, "node_modules"), path.join(work, "node_modules"));
  writeFileSync(
    path.join(work, "tools/mutation/catalog.json"),
    JSON.stringify({
      format: "typesys.mutation-catalog/1",
      mutations: [{ id: "p3.canonical-reversed", adr: "0070", description: "Canonical JSON sorts keys backwards.", file: TARGET, find: FIND, replace: REPLACE, tests: ["packages/domain-airforce/test/release-boundary.test.ts"] }]
    })
  );
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=p3@example.invalid", "-c", "user.name=p3", ...a], { cwd: work, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "scratch");
}

describe("P3 mutation runner review (ADR-0070)", () => {
  it("P3-M1: Ctrl-C (SIGINT to the process group) while the mutated tree is rebuilt and tested leaves neither the source nor the build mutated", { timeout: 600_000 }, async () => {
    scratchRepository();
    const original = readFileSync(path.join(work, TARGET), "utf8");
    const child = spawn("npm", ["run", "mutation", "--", "--allow-dirty", "--out", path.join(work, "evidence.json")], { cwd: work, detached: true, stdio: "ignore", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV" && k !== "TEST")) });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const deadline = Date.now() + 400_000;
    while (Date.now() < deadline && readFileSync(path.join(work, TARGET), "utf8") === original) await new Promise((r) => setTimeout(r, 50));
    // The moment the forced rebuild has written the mutated output, as a person pressing Ctrl-C at any point might.
    while (Date.now() < deadline && !readFileSync(path.join(work, BUILT), "utf8").includes(REPLACE)) await new Promise((r) => setTimeout(r, 20));
    process.kill(-child.pid!, "SIGINT");
    await exited;
    // Give a restoring handler every chance to have run.
    await new Promise((r) => setTimeout(r, 3_000));
    // ADR-0070: the harness "restores the file, also on an error or a signal"; a build left mutated means every later test runs on the defect.
    expect.soft(readFileSync(path.join(work, TARGET), "utf8"), "source restored").toBe(original);
    expect(readFileSync(path.join(work, BUILT), "utf8"), "build restored").not.toContain(REPLACE);
  });
});
