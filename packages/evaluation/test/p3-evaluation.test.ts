import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARMS, contractText, createSandbox, EVALUATION_DIR, hiddenFile, loadHidden, loadTask, measureCode, renderReport, scoreApp, taskIds, violations, type RunScore } from "../src/index.js";

/**
 * Independent review (P3) of the evaluation harness (ADR-0073). Each test
 * states what the ADR promises and fails while the harness does otherwise.
 */
const person = { source: "person" as const, producer: "p3", humanInterventions: 0 };

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("P3 evaluation harness review (ADR-0073)", () => {
  it("P3-V1: an application that refuses everything (403, 404 for runs) passes no hidden check", { timeout: 600_000 }, async () => {
    const dir = scratch("p3-deny-app-");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "deny-app", private: true, scripts: { start: "node server.mjs" } }));
    writeFileSync(
      path.join(dir, "server.mjs"),
      [
        'import { createServer } from "node:http";',
        "createServer((q, s) => {",
        '  const send = (c) => { s.writeHead(c, { "content-type": "application/json" }); s.end("{}"); };',
        '  if (q.url === "/api/me") return send(q.headers.authorization ? 200 : 401);',
        '  if (q.method === "GET" && q.url.startsWith("/api/workflow-runs/")) return send(404);',
        '  if (q.method === "GET" && q.url.startsWith("/api/objects/")) return send(q.headers.authorization ? 404 : 403);',
        "  return send(403);",
        '}).listen(Number(process.env.PORT), "127.0.0.1");'
      ].join("\n")
    );
    const passedChecks: string[] = [];
    for (const id of taskIds()) {
      const score = await scoreApp({ task: id, arm: "agent-without", dir, hidden: await loadHidden(hiddenFile(id)), production: person });
      expect(score.started).toBe(true);
      passedChecks.push(...score.checks.filter((c) => c.ok).map((c) => `${id}:${c.id}`));
    }
    rmSync(dir, { recursive: true, force: true });
    expect(passedChecks).toEqual([]);
  });

  it("P3-V2: nothing inside an arm's sandbox reaches the hidden checks by a relative path", { timeout: 120_000 }, () => {
    const dir = scratch("p3-sandbox-");
    createSandbox(path.resolve(EVALUATION_DIR, "../.."), dir, loadTask("requisition-expedite"), ARMS["agent-without"], contractText());
    // Deliberately not path.join: the OS, not Node, resolves `..` through the node_modules symlink.
    const viaSymlink = `${dir}/node_modules/vitest/../../packages/evaluation/hidden/requisition-expedite.mjs`;
    const reachable = existsSync(viaSymlink);
    rmSync(dir, { recursive: true, force: true });
    expect(reachable).toBe(false);
  });

  it("P3-V3: an agent-without application reaching the composition platform by a relative path, or another unlisted @typesys package, is reported as an off-arm import", () => {
    const dir = scratch("p3-imports-");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(
      path.join(dir, "src/server.ts"),
      ['import { createGovernedApi } from "../../packages/http/dist/index.js";', 'import { startDemo } from "@typesys/demo-web";', "export { createGovernedApi, startDemo };"].join("\n")
    );
    const code = measureCode(dir);
    rmSync(dir, { recursive: true, force: true });
    const score: RunScore = { task: "t", arm: "agent-without", at: "", production: person, built: true, started: true, checks: [], passed: 0, total: 1, code };
    const flagged = violations(score);
    expect(flagged.some((i) => i.includes("http"))).toBe(true);
    expect(flagged).toContain("@typesys/demo-web");
  });

  it("P3-V4: a loss is a run beaten by the best run of *another* arm; two runs of one arm are not losses", () => {
    const run = (passed: number): RunScore => ({ task: "t", arm: "agent-with", at: "", production: person, built: true, started: true, checks: [{ id: "a", ok: passed === 1 }], passed, total: 1 });
    expect(renderReport([run(1), run(0)])).not.toContain("### Losses");
  });

  it("P3-V5: the report shows the prior art recorded with a run, and an arm with no run as not run", () => {
    const s: RunScore = { task: "t", arm: "agent-with", at: "", production: { ...person, notes: "prior art: packages/x/leadApproval.ts" }, built: true, started: true, checks: [], passed: 0, total: 1 };
    const md = renderReport([s]);
    expect(md).toContain("packages/x/leadApproval.ts");
    expect(md.toLowerCase()).toContain("not run");
  });
});
