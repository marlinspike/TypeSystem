import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { callEngineerTool, loadHost, planMission, runCheck, type AcceptanceCheck, type MissionSpec } from "../src/index.js";

/**
 * The engineering loop after its independent review (ADR-0071, amended).
 * What `runCheck` counts as the runtime's answer: a negative check needs a
 * positive signal, and an approval tests its caller only while the run
 * waits on that step. And what plan and the MCP tools refuse.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(path.resolve(here, "../../../examples/missions/component-replacement/mission.json"), "utf8")) as MissionSpec;

type Reply = { status: number; body?: unknown };
let server: Server | undefined;
afterEach(() => server?.close());

async function app(route: (req: IncomingMessage) => Reply): Promise<string> {
  server = createServer((req, res) => {
    const { status, body } = route(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const token = (req: IncomingMessage) => (req.headers.authorization ?? "").replace("Bearer ", "");
const run = (base: string, check: AcceptanceCheck) => runCheck(base, { ...doc, acceptance: [check] }, check);
const approves = doc.acceptance.find((c) => c.kind === "approves" && !c.admitted)!;

describe("runCheck signals", () => {
  it("a 404 is a refusal only when another of the mission's callers reads the object", async () => {
    const check: AcceptanceCheck = { id: "r", kind: "refused", as: "viewer", type: "airforce.Component", objectId: "c1" };
    const reader = doc.callers.maintainer!.token;
    const base = await app((req) => (token(req) === reader ? { status: 200, body: { values: {} } } : { status: 404 }));
    expect((await run(base, check)).observed).toEqual({ status: 404, readBy: "maintainer" });
    expect((await run(base, check)).ok).toBe(true);
  });

  it("an approves check fails when the run is not waiting on its step, whatever the approval answers", async () => {
    const base = await app((req) => (req.url?.includes("/runs") ? { status: 201, body: { runId: "r1", status: "completed" } } : { status: 403 }));
    const result = await run(base, approves);
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.message).toMatch(/not waiting on/);
  });

  it("an approval that answers neither yes (200) nor no (403) decides nothing", async () => {
    const step = (approves as Extract<AcceptanceCheck, { kind: "approves" }>).step;
    const base = await app((req) => (req.url?.includes("/runs") ? { status: 201, body: { runId: "r1", status: "waiting-approval", waitingOn: { step } } } : { status: 409 }));
    const result = await run(base, approves);
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.message).toMatch(/did not answer/);
  });

  it("a caller refused the Action list is not offered the Action; a missing route offers nothing either way", async () => {
    const check: AcceptanceCheck = { id: "o", kind: "offered", as: "viewer", type: "airforce.Aircraft", action: "x", offered: false };
    expect((await run(await app(() => ({ status: 403 })), check)).ok).toBe(true);
    server!.close();
    expect((await run(await app(() => ({ status: 404 })), check)).ok).toBe(false);
  });
});

describe("plan and the MCP tools", () => {
  it("a check on an object no caller finds is an error, not a warning", async () => {
    const { host, resolve, workflows } = await loadHost(doc, path.resolve(here, ".."));
    const ghost: AcceptanceCheck = { id: "ghost", kind: "refused", as: "viewer", type: "airforce.Component", objectId: "comp-does-not-exist" };
    const plan = await planMission({ ...doc, acceptance: [...doc.acceptance, ghost] }, host, resolve, workflows);
    expect(plan.ok).toBe(false);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-object", severity: "error", at: `acceptance/${doc.acceptance.length}` }));
  });

  it("a file inside the root that is not a mission is reported without its contents", async () => {
    const root = path.resolve(here, "..", ".work", "review-fixes");
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "notes.json"), "TOPSECRET-1182 not a mission");
    const result = await callEngineerTool(root, "typesys_engineer_plan", { mission: "notes.json" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
  });
});
