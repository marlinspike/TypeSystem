import { createServer, type Server } from "node:http";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callEngineerTool, insideRoot, loadHost, missionProblems, planMission, runCheck, scaffoldMission, verifyMission, type AcceptanceCheck, type MissionSpec } from "../src/index.js";

/**
 * Independent adversarial review of M4 (ADR-0071), fast reproductions.
 * Each `it` that is not marked "held" states the behaviour the ADR promises
 * and fails on 0907181. See docs/reviews/m4-adversarial-review.md.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const MISSION = path.resolve(pkg, "../../examples/missions/component-replacement/mission.json");
const doc = JSON.parse(readFileSync(MISSION, "utf8")) as MissionSpec;
const WORK = path.join(pkg, ".work", "m4-adv-fast");

/** An "application" that answers every request with `status` and `body`. */
async function fakeApp(status: number, body: unknown): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

const byId = (id: string) => doc.acceptance.find((c) => c.id === id)!;

describe("M4 adversarial: checks that pass against an application that does nothing", () => {
  let notFound: { baseUrl: string; server: Server };
  let empty: { baseUrl: string; server: Server };
  beforeAll(async () => {
    notFound = await fakeApp(404, { title: "No such route" });
    empty = await fakeApp(200, {});
  });
  afterAll(() => {
    notFound.server.close();
    empty.server.close();
  });

  it("F1: an application that 404s every route fails the mission's negative checks (it passes all four today)", async () => {
    const negative = ["anonymous-sees-nothing", "viewer-not-offered-work-order", "viewer-cannot-request"].map(byId);
    const described: AcceptanceCheck = { id: "anonymous-not-told", kind: "described", as: "anonymous", type: "airforce.Aircraft", described: false };
    const results = await Promise.all([...negative, described].map((c) => runCheck(notFound.baseUrl, { ...doc, acceptance: [...doc.acceptance, described] }, c)));
    // A route that does not exist is not the runtime refusing the caller: none of these was decided by policy.
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
  });

  it("F2: a reads check with only `withheld`, and a query with only `atMost`, fail against a 200 that carries no data (they pass today)", async () => {
    const withheldOnly: AcceptanceCheck = { id: "w", kind: "reads", as: "viewer", type: "airforce.Aircraft", objectId: "AF86-0147", withheld: ["maintenanceStatus"] };
    const atMostOnly: AcceptanceCheck = { id: "q", kind: "query", as: "viewer", query: { type: "airforce.WorkOrder" }, atMost: 0 };
    const spec = { ...doc, acceptance: [withheldOnly, atMostOnly] };
    const results = await Promise.all(spec.acceptance.map((c) => runCheck(empty.baseUrl, spec, c)));
    expect(results.map((r) => r.ok)).toEqual([false, false]);
  });
});

describe("M4 adversarial: what plan accepts", () => {
  it("F3: an approves check whose `step` names no approval of the workflow is an error in plan (accepted today)", async () => {
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    const acceptance = doc.acceptance.map((c) => (c.id === "lead-cannot-approve-own-request" ? { ...c, step: "leadAproval" } : c));
    const plan = await planMission({ ...doc, acceptance }, host, resolve, workflows);
    expect(plan.ok).toBe(false);
  });

  it("F4: a check that names no caller (`as` missing) is invalid; today it silently runs as the anonymous caller", () => {
    const acceptance = doc.acceptance.map((c, i) => (i === 0 ? (({ as: _as, ...rest }) => rest)(c) : c));
    expect(missionProblems({ ...doc, acceptance }).map((d) => d.at)).toContain("acceptance/0");
  });

  it("F5: a refused check on an object that does not exist is an error in plan (accepted today: it passes for every caller)", async () => {
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    const ghost: AcceptanceCheck = { id: "maintainer-refused-ghost", kind: "refused", as: "maintainer", type: "airforce.Component", objectId: "comp-does-not-exist" };
    const plan = await planMission({ ...doc, acceptance: [...doc.acceptance, ghost] }, host, resolve, workflows);
    expect(plan.diagnostics.map((d) => d.at)).toContain(`acceptance/${doc.acceptance.length}`);
  });

  it("F6: a reference with a dotted path ($component.aircraftId.x) is reported, not silently cut to $component.aircraftId", async () => {
    const steps = doc.workflow!.steps.map((s) => (s.kind === "check" ? { ...s, equal: ["$component.aircraftId.anything", "$event.aircraftId"] as const } : s));
    const spec = { ...doc, workflow: { ...doc.workflow!, steps } } as MissionSpec;
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    const plan = await planMission(spec, host, resolve, workflows);
    expect(plan.diagnostics.map((d) => d.at)).toContain("workflow/steps/2");
  });

  it("F7: a caller the spec names but no check covers is reported by plan (silent today)", async () => {
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    const spec = { ...doc, callers: { ...doc.callers, auditor: { token: "demo-auditor-token" } } };
    const plan = await planMission(spec, host, resolve, workflows);
    expect(plan.diagnostics.map((d) => d.at)).toContain("callers/auditor");
  });
});

describe("M4 adversarial: spec strings become code in the scaffold", () => {
  // Both payloads typecheck: the scaffold writes them as code, tsc emits them, and the server runs them when it loads.
  const injected = (): MissionSpec => ({
    ...doc,
    workflow: {
      ...doc.workflow!,
      steps: doc.workflow!.steps.map((s) => (s.kind === "approval" ? { ...s, deadlineMs: '(((globalThis as Record<string, unknown>)["m4Injected"] = "deadlineMs"), 86400000)' as unknown as number } : s))
    },
    views: [{ ...doc.views![0]!, limit: '1).where(((globalThis as Record<string, unknown>)["m4Injected"] = "limit") as never' as unknown as number }]
  });

  it("F8: an approval deadlineMs, a view limit or a view name that is not what it claims to be is invalid-mission (accepted today)", () => {
    const at = missionProblems(injected()).map((d) => d.at);
    expect(at).toEqual(expect.arrayContaining([expect.stringMatching(/^views\/0/), expect.stringMatching(/^workflow\/steps\/3/)]));
    const badName = { ...doc, views: [{ ...doc.views![0]!, name: "componentList() {} function X" }] };
    expect(missionProblems(badName).map((d) => d.at)).toEqual(expect.arrayContaining([expect.stringMatching(/^views\/0/)]));
  });

  it("F8 (evidence): today the deadlineMs string compiles into workflow.ts and runs when the module loads", async () => {
    const dir = path.join(WORK, "inject");
    await rm(dir, { recursive: true, force: true });
    const { host } = await loadHost(doc, pkg);
    await scaffoldMission(injected(), host, dir);
    const tsc = path.resolve(pkg, "../../node_modules/typescript/bin/tsc");
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [tsc, "-p", dir, "--pretty", "false"], { cwd: dir });
    delete (globalThis as Record<string, unknown>).m4Injected;
    await import(pathToFileURL(path.join(dir, "dist", "workflow.js")).href);
    expect((globalThis as Record<string, unknown>).m4Injected).toBeUndefined();
  }, 60_000);
});

describe("M4 adversarial: the MCP tools' root", () => {
  const root = path.join(WORK, "root");
  const outside = path.join(WORK, "outside");
  beforeAll(async () => {
    await rm(WORK + "/root", { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "mission.json"), JSON.stringify(doc));
    await symlink(outside, path.join(root, "out-link"));
    await writeFile(path.join(outside, "secret.txt"), "TOPSECRET-4471 do not disclose");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "notes.json"));
  });

  it("F9: scaffold into a symlink that leads outside the root is refused (today it writes outside)", async () => {
    const result = await callEngineerTool(root, "typesys_engineer_scaffold", { mission: "mission.json", out: "out-link" });
    const written = (await readdir(outside)).filter((f) => f !== "secret.txt");
    expect({ ok: result.ok, written }).toEqual({ ok: false, written: [] });
  });

  it("F10: plan on a symlink to a file outside the root does not disclose that file's contents (today the JSON error quotes it)", async () => {
    const result = await callEngineerTool(root, "typesys_engineer_plan", { mission: "notes.json" });
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
  });

  it("F11: a mission inside the root whose host.module is an absolute path outside it is refused before the module runs", async () => {
    const marker = path.join(outside, "ran.txt");
    await writeFile(path.join(outside, "evil.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); export const build = () => ({}); export const ids = () => ({});`);
    await writeFile(path.join(root, "evil-mission.json"), JSON.stringify({ ...doc, host: { module: path.join(outside, "evil.mjs"), build: "build", identities: "ids" } }));
    await callEngineerTool(root, "typesys_engineer_plan", { mission: "evil-mission.json" });
    expect(existsSync(marker)).toBe(false);
  });

  it("F12: verify whose tsconfig sends output outside the root is refused (today tsc writes there)", async () => {
    const app = path.join(root, "app");
    const { host } = await loadHost(doc, pkg);
    await scaffoldMission(doc, host, app);
    const tsconfig = JSON.parse(readFileSync(path.join(app, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    tsconfig.compilerOptions.outDir = path.relative(app, path.join(outside, "emitted"));
    await writeFile(path.join(app, "tsconfig.json"), JSON.stringify(tsconfig));
    await callEngineerTool(root, "typesys_engineer_verify", { dir: "app" });
    expect(existsSync(path.join(outside, "emitted"))).toBe(false);
  }, 120_000);

  it("F13: a directory whose name starts with two dots is inside the root", () => {
    expect(insideRoot(root, "..cache/mission.json")).toBe(path.join(root, "..cache/mission.json"));
  });

  it("held: a plain ../ path and an absolute path are refused", () => {
    expect(() => insideRoot(root, "../outside")).toThrow(/outside/);
    expect(() => insideRoot(root, outside)).toThrow(/outside/);
  });
});

describe("M4 adversarial: diagnostics", () => {
  it("F14: verify of a mission whose host module does not resolve is a diagnostic at host/module, not a rejected promise", async () => {
    const dir = path.join(WORK, "missing-host");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "mission.json"), JSON.stringify({ ...doc, host: { ...doc.host, module: "@typesys/domain-airforse" } }));
    const report = await verifyMission(dir).catch((err: Error) => ({ rejected: err.message }));
    expect(report).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ at: "host/module" })]) as unknown });
  });
});
