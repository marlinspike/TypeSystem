import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARMS, buildReference, contamination, contractText, createSandbox, EVALUATION_DIR, hiddenFile, loadHidden, loadTask, measureCode, renderReport, scoreApp, taskIds } from "../src/index.js";

/**
 * The evaluation harness (ADR-0073) is checked before any arm is run: each
 * task's hidden checks can be passed (by a reference application the
 * engineering loop scaffolds from a spec), an application that does nothing
 * passes none of them, and an arm's sandbox withholds what it must.
 */
const WORK = path.join(EVALUATION_DIR, ".work");
const reference = { source: "reference" as const, producer: "engineering-loop scaffold of references/<task>.json", humanInterventions: 0 };

describe("the evaluation harness", () => {
  for (const id of taskIds()) {
    it(`${id}: the reference application passes every hidden check`, { timeout: 600_000 }, async () => {
      const hidden = await loadHidden(hiddenFile(id));
      expect(hidden.length).toBeGreaterThanOrEqual(8);
      const dir = await buildReference(id, path.join(WORK, "reference", id));
      const score = await scoreApp({ task: id, arm: "agent-with", dir, hidden, production: reference });
      expect(score.checks.filter((c) => !c.ok)).toEqual([]);
      expect(score.passed).toBe(hidden.length);
    });
  }

  it("an application that answers every request with 404 passes no hidden check", { timeout: 300_000 }, async () => {
    const dir = path.join(WORK, "null-app");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "null-app", private: true, scripts: { start: "node server.mjs" } }));
    await writeFile(path.join(dir, "server.mjs"), 'import { createServer } from "node:http";\ncreateServer((_q, s) => { s.writeHead(404, { "content-type": "application/json" }); s.end("{}"); }).listen(Number(process.env.PORT), "127.0.0.1");\n');
    for (const id of taskIds()) {
      const score = await scoreApp({ task: id, arm: "agent-without", dir, hidden: await loadHidden(hiddenFile(id)), production: reference });
      expect({ id, passed: score.passed, started: score.started }).toEqual({ id, passed: 0, started: true });
    }
  });

  it("a sandbox withholds the hidden checks, the existing missions and the history, and lists prior art", { timeout: 120_000 }, async () => {
    // Outside the repository: a sandbox is a copy of it.
    const dir = await mkdtemp(path.join(tmpdir(), "typesys-eval-sandbox-"));
    const task = loadTask("requisition-expedite");
    createSandbox(path.resolve(EVALUATION_DIR, "../.."), dir, task, ARMS["agent-without"], contractText());
    for (const gone of ["packages/evaluation", "examples/missions", ".git", "packages/engineer/test", ".claude"]) expect(existsSync(path.join(dir, gone)), gone).toBe(false);
    expect(readFileSync(path.join(dir, "REQUIREMENT.md"), "utf8")).toBe(task.requirement);
    expect(existsSync(path.join(dir, "node_modules/@typesys/core/package.json"))).toBe(true);
    expect(contamination(dir, task)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("measures code and renders every run, losses with the checks that decided them", () => {
    const code = measureCode(path.join(EVALUATION_DIR, "src"));
    expect(code.codeLines).toBeGreaterThan(100);
    const md = renderReport([
      { task: "t", arm: "agent-with", at: "", production: reference, built: true, started: true, checks: [{ id: "a", ok: true }], passed: 1, total: 1 },
      { task: "t", arm: "agent-without", at: "", production: reference, built: true, started: true, checks: [{ id: "a", ok: false, message: "403 expected, got 200" }], passed: 0, total: 1 }
    ]);
    expect(md).toContain("### Losses");
    expect(md).toContain("403 expected, got 200");
  });
});
