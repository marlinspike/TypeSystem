import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callEngineerTool, runCheck, type AcceptanceCheck, type MissionSpec } from "../src/index.js";

/**
 * Pressure test 3 (P3) of the engineering loop (ADR-0071), after the M4
 * review's fixes. Each test states what the ADR or the review's disposition
 * promises and fails on the reviewed head (identical to PR #14).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const MISSION = path.resolve(pkg, "../../examples/missions/sortie-readiness/mission.json");
const doc = JSON.parse(readFileSync(MISSION, "utf8")) as MissionSpec;
const WORK = path.join(pkg, ".work", "p3-engineer");
const root = path.join(WORK, "root");
const outside = path.join(WORK, "outside");

beforeAll(async () => {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterAll(() => rm(WORK, { recursive: true, force: true }));

/** A module outside the root that records that it ran. */
async function evil(name: string): Promise<{ file: string; marker: string }> {
  const marker = path.join(outside, `${name}.ran`);
  const file = path.join(outside, `${name}.mjs`);
  await writeFile(file, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export const build = () => ({}); export const ids = () => ({});`);
  return { file, marker };
}

describe("P3 engineer: the MCP root confines host.module (the review's L5) in every spelling", () => {
  it("P3-E1: a host.module path that leads through a symlink inside the root to a file outside it is refused before it runs", async () => {
    const { marker } = await evil("via-symlink");
    await symlink(outside, path.join(root, "linked"), "dir");
    await writeFile(path.join(root, "symlink-mission.json"), JSON.stringify({ ...doc, host: { module: "./linked/via-symlink.mjs", build: "build", identities: "ids" } }));
    const result = await callEngineerTool(root, "typesys_engineer_plan", { mission: "symlink-mission.json" });
    expect(existsSync(marker)).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("P3-E1b: a package-relative specifier that climbs out of a package (`esbuild/../../…`) is refused before it runs", async () => {
    const { file, marker } = await evil("via-package");
    // esbuild declares no `exports`, so Node resolves a subpath of it as a plain path, `..` and all.
    const esbuildDir = path.dirname(createRequire(path.join(root, "noop.js")).resolve("esbuild/package.json"));
    const specifier = `esbuild/${path.relative(esbuildDir, file).split(path.sep).join("/")}`;
    await writeFile(path.join(root, "package-mission.json"), JSON.stringify({ ...doc, host: { module: specifier, build: "build", identities: "ids" } }));
    const result = await callEngineerTool(root, "typesys_engineer_plan", { mission: "package-mission.json" });
    expect(existsSync(marker)).toBe(false);
    expect(result.ok).toBe(false);
  });
});

/** The independent services this process has started and not stopped (examples/services/<name>/server.mjs). */
function serviceChildren(): number[] {
  const out = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)], { encoding: "utf8" });
  return out.split("\n").filter((l) => /examples\/services\/[a-z-]+\/server\.mjs/.test(l)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

describe("P3 engineer: the MCP tools start nothing but the application they verify", () => {
  it("P3-E4: typesys_engineer_plan on the sortie-readiness mission leaves no service processes running", async () => {
    const before = serviceChildren();
    await writeFile(path.join(root, "sortie.json"), JSON.stringify(doc));
    const result = await callEngineerTool(root, "typesys_engineer_plan", { mission: "sortie.json" });
    expect(result.ok).toBe(true);
    const leaked = serviceChildren().filter((pid) => !before.includes(pid));
    for (const pid of leaked) process.kill(pid);
    // mcp.ts: "it never starts anything but the application it verifies". Today each plan call starts the
    // host's three services (buildSortieHost with no urls) and never stops them: three processes per call,
    // for the life of the MCP server.
    expect(leaked).toEqual([]);
  }, 60_000);
});

describe("P3 engineer: verdicts decided on part of the answer", () => {
  let server: Server;
  let baseUrl = "";
  beforeAll(async () => {
    // An application whose first page of a query is empty but not the last: what the runtime returns when the
    // adapter's page holds only rows the caller is denied (a denied item is dropped per page, ADR-0030), and
    // a run that fails at its first read rather than at the guard the requirement names.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        res.writeHead(req.url === "/api/workflows/ops.ConfirmSortie/runs" ? 201 : 200, { "content-type": "application/json" });
        if (req.url === "/api/query") {
          const q = JSON.parse(body) as { cursor?: string };
          res.end(JSON.stringify(q.cursor === undefined ? { items: [], nextCursor: "1" } : { items: [{ typeName: "ops.Requisition", objectId: "KHIF-6281-0001", values: {} }] }));
        } else {
          res.end(JSON.stringify({ runId: "r1", status: "failed", reason: "step aircraft failed: Fleet registry could not be reached", steps: [{ name: "aircraft", status: "failed", attempts: 1 }, { name: "pilot", status: "pending", attempts: 0 }, { name: "pilotAssigned", status: "pending", attempts: 0 }] }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("P3-E2: `atMost: 0` does not pass on an empty first page that has a nextCursor (the caller reads a row on the next page)", async () => {
    const check: AcceptanceCheck = { id: "viewer-reads-no-parts", kind: "query", as: "viewer", query: { type: "ops.Requisition" }, atMost: 0 };
    const result = await runCheck(baseUrl, { ...doc, acceptance: [check] }, check);
    // Today: ok, observed { count: 0 }; the nextCursor the API returned is never followed.
    expect(result.ok).toBe(false);
  });

  it("P3-E3: `starts … failed` passes only when the run fails at a guard of the workflow, not when its first read fails", async () => {
    const check = doc.acceptance.find((c) => c.id === "unassigned-pilot-fails")!;
    const result = await runCheck(baseUrl, doc, check);
    // The requirement is "never for a pilot not assigned to that aircraft": the pilotAssigned check never ran.
    expect(result.ok).toBe(false);
  });
});
