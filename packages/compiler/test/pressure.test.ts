import http from "node:http";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, checkApp, compileApp, diffApps, findChromium, missionToApp, runScreenCheck, type AppSpec, type ScreenCheck } from "../src/index.js";
import { appProblems } from "../src/parse.js";
import { squadronDir, WORK } from "./apps.js";
import { airforceEnv, squadronApp } from "./fixtures.js";

/**
 * The findings of the 4.0 pressure test (docs/reviews/4-0-pressure-test.md),
 * each as the defect it was: every test here failed before its fix.
 */
type App = ReturnType<typeof squadronApp>;
// The fixture is data: tests reach into it by path, as an agent's edit would.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
const errors = (ds: readonly { severity: string; code: string; at: string }[]) => ds.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.at}`);
const steps = (a: App): any[] => (a as any).flows.ground.steps;
const chrome = findChromium();

describe("4.0 pressure test: what reaches generated code", () => {
  it("P4-01: design.system is a shipped system or <module>#<export>, never text spliced into the client", async () => {
    for (const system of ["theme#overrides }, alert(1); ({ x: 1", "../../../../etc/passwd-like#X", "brand theme#Overrides", "meridian; alert(1)"]) {
      const app = { ...squadronApp(), design: { system } };
      expect(errors(appProblems(app)), system).toEqual(["invalid-app /design/system"]);
    }
    expect(errors(appProblems({ ...squadronApp(), design: { system: "meridian", colour: "red" } }))).toEqual(["invalid-app /design/colour"]);
    expect(appProblems({ ...squadronApp(), design: { system: "brand/theme#overrides", density: "compact", signIn: "presets" } })).toEqual([]);
  });

  it("P4-02: a lock entry outside the application is refused, and nothing outside it is removed", async () => {
    const dir = await squadronDir("p4-02");
    await compileApp(dir);
    const victim = path.join(WORK, "p4-02-victim.txt");
    await writeFile(victim, "not the compiler's");
    const lockFile = path.join(dir, "typesys.lock.json");
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    lock.files["../p4-02-victim.txt"] = "0".repeat(64);
    await writeFile(lockFile, JSON.stringify(lock));
    const r = await compileApp(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === "invalid-lock")).toMatchObject({ at: "typesys.lock.json" });
    expect(existsSync(victim)).toBe(true);
  });

  it("P4-03: without a lock, a generated file that differs is not overwritten unless told to", async () => {
    const dir = await squadronDir("p4-03");
    await compileApp(dir);
    const board = path.join(dir, "src/generated/pages/Board.tsx");
    await writeFile(board, `${await readFile(board, "utf8")}\n// someone's work\n`);
    await writeFile(path.join(dir, "typesys.lock.json"), "{ not json");
    const r = await compileApp(dir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === "edited-generated-file")).toMatchObject({ at: "src/generated/pages/Board.tsx" });
    expect(await readFile(board, "utf8")).toContain("someone's work");
    // A file that already says what the compiler writes is still taken over, and --force discards the edit.
    expect((await compileApp(dir, { force: true })).ok).toBe(true);
    expect(await readFile(board, "utf8")).not.toContain("someone's work");
  });

  it("P4-08 to P4-11: names that clash with generated code, and a title with a backslash, still build", async () => {
    const app: any = squadronApp();
    app.title = "Squadron C:\\users\\ops `${x}`";
    app.flows = { path: app.flows.ground };
    app.pages[0].layout.children[1].rowActions[0].do[0].run = "path";
    app.pages[0].name = "Table";
    app.acceptance[4].page = "Table";
    app.pages[0].data = { local: app.pages[0].data.selectedAircraft };
    app.pages[0].layout.children[2].data = "local";
    const dir = await squadronDir("p4-08", app);
    const r = await compileApp(dir);
    expect(errors(r.diagnostics)).toEqual([]);
    expect(await buildApp(dir)).toEqual([]);
  }, 120_000);
});

describe("4.0 pressure test: what the checker decides", () => {
  it("P4-05: ordering a date against a plain string is refused, as ordering two plain strings is", async () => {
    const app: any = squadronApp();
    app.flows.ground.input.since = { schema: { type: "string", format: "date-time" } };
    app.flows.ground.input.label = { schema: { type: "string" } };
    steps(app)[3].assert = { lt: ["$input.since", "$input.label"] };
    const comparisons = async () => errors((await checkApp(app as AppSpec, await airforceEnv())).diagnostics).filter((e) => e.startsWith("not-comparable"));
    expect(await comparisons()).toEqual(["not-comparable /flows/ground/steps/3/assert/lt"]);
    steps(app)[3].assert = { lt: ["$input.since", "2026-10-17T00:00:00Z"] };
    expect(await comparisons()).toEqual([]);
    steps(app)[3].assert = { lt: ["$input.since", "Bravo 7"] };
    expect(await comparisons()).toEqual(["not-comparable /flows/ground/steps/3/assert/lt"]);
  });

  it("P4-13: a misspelt assertion in a check is an error, not a check that decides nothing", () => {
    const app: any = squadronApp();
    app.acceptance[0].witheld = app.acceptance[0].withheld;
    delete app.acceptance[0].withheld;
    app.acceptance[4].absenttext = ["NMC"];
    app.acceptance[4].rows["attention-table"].atleast = 1;
    expect(errors(appProblems(app))).toEqual(["invalid-app /acceptance/0/witheld", "invalid-app /acceptance/4/absenttext", "invalid-app /acceptance/4/rows/attention-table/atleast"]);
  });

  it("P4-14: a retry on a read inside parallel retries the parallel step", async () => {
    const app: any = squadronApp();
    steps(app)[1].steps[0].retry = { maxAttempts: 5, backoffMs: 100 };
    const dir = await squadronDir("p4-14", app);
    expect((await compileApp(dir)).ok).toBe(true);
    const flow = await readFile(path.join(dir, "src/generated/flows/ground.ts"), "utf8");
    expect(flow).toMatch(/name: "evidence",[\s\S]*?retry: \{"maxAttempts":5,"backoffMs":100\}/);
  });

  it("P4-15: a value from a read that may fail and carry on is maybe-skipped wherever it is required", async () => {
    const app: any = squadronApp();
    steps(app)[0].onError = "continue";
    steps(app)[6].input.assignedTo = "$aircraft.tailNumber";
    const r = await checkApp(app as AppSpec, await airforceEnv());
    expect(errors(r.diagnostics)).toContain("maybe-skipped /flows/ground/steps/6/input/assignedTo");
  });

  it("P4-16: a page param is a string, because it comes from the path", () => {
    const app: any = squadronApp();
    app.pages.push({ name: "Top", title: "Top", path: "/top/:n", params: { n: { schema: { type: "integer" } } }, layout: { kind: "text", id: "t", text: "top" } });
    expect(errors(appProblems(app))).toEqual(["page-param /pages/1/params/n/schema/type"]);
  });

  it("P4-12: a changed model, or LLM configuration, reaches the flows whose AI steps ask it", () => {
    const before = squadronApp() as AppSpec;
    const model: any = structuredClone(before);
    model.models.triage.id = "commercial";
    expect(diffApps(before, model).impact.checks).toEqual(expect.arrayContaining(["maintainer-grounds", "lead-approves"]));
    const llm: any = structuredClone(before);
    llm.llm = "other.llm.json";
    const d = diffApps(before, llm);
    expect(d.impact.checks).toEqual(expect.arrayContaining(["maintainer-grounds", "lead-approves"]));
    expect(d.changes.some((c) => c.what === "llm")).toBe(true);
  });

  it("P4-20 (does not reproduce): a mission whose view limit an application would refuse is refused as a mission first", () => {
    for (const limit of [0, 5000, 2.5]) {
      const r = missionToApp(sortieWithLimit(limit));
      expect(r.spec).toBeUndefined();
      expect(errors(r.diagnostics)).toEqual(["invalid-mission /views/0/limit"]);
    }
  });
});

function sortieWithLimit(limit: number): unknown {
  return {
    format: "typesys.mission/1",
    name: "fleet-view",
    requirement: "A planner sees the fleet.",
    host: { module: "@typesys/sortie-readiness", build: "buildSortieHost", identities: "resolveSortieIdentity" },
    callers: { planner: { token: "demo-planner-token" } },
    uses: { types: ["ops.Aircraft"] },
    views: [{ name: "FleetBoard", title: "Fleet", type: "ops.Aircraft", fields: ["tailNumber"], limit }],
    acceptance: [{ id: "planner-reads", kind: "reads", as: "planner", type: "ops.Aircraft", objectId: "AF86-0147", sees: ["tailNumber"] }]
  };
}

describe.skipIf(!chrome)("4.0 pressure test: what a screen check decides", () => {
  it("P4-07: a page that never settles fails its check, however negative its assertions", async () => {
    const server = http.createServer((req, res) => {
      if (req.url !== "/") return void res.writeHead(404).end();
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html><body><div id=root></div><script type=module src=/missing.js></script></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const check: ScreenCheck = { id: "never-settles", kind: "screen", as: "viewer", page: "Board", hidden: ["maintenance-status"], absentText: ["NMC"], rows: { "attention-table": { atMost: 0 } } };
      const spec = { callers: { viewer: { token: "" } }, pages: [{ name: "Board", path: "/" }], acceptance: [check] } as unknown as AppSpec;
      const r = await runScreenCheck(url, spec, check);
      expect(r.ok).toBe(false);
      expect(r.diagnostic?.message).toMatch(/did not settle/);
      expect(r.diagnostic?.message).toMatch(/missing\.js/);
    } finally {
      server.close();
    }
  }, 30_000);
});
