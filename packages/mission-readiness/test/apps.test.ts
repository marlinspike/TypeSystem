import type { Server } from "node:http";
import path from "node:path";
import type { Express } from "express";
import { describe, it, expect, afterAll } from "vitest";
import { requireRole } from "@typesys/core";
import { CLIENT_CSP } from "@typesys/http";
import { MISSION_TOKENS, buildMissionBackend, createComposedApp, createHandwrittenApp, missionFleet, resolveMissionIdentity, type MissionBackend } from "../src/index.js";

const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function serve(create: (backend: MissionBackend, dir: string) => Express, dir = path.resolve(import.meta.dirname, "missing")): Promise<string> {
  const app = create(await buildMissionBackend(), dir);
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const call = async (base: string, method: "GET" | "POST", p: string, token?: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const answer: unknown = await res.json();
  return { status: res.status, body: answer };
};

describe("the mission fleet (ADR-0063)", () => {
  it("is the same every time, so both applications and their tests see one fleet", () => {
    const a = missionFleet();
    expect(missionFleet()).toEqual(a);
    expect(a.aircraft).toHaveLength(24);
    // Every work order names an event, and every event an aircraft, of the fleet.
    const tails = new Set(a.aircraft.map((x) => x.objectId));
    const events = new Set(a.events.map((e) => e.event_id));
    expect(a.events.every((e) => tails.has(e.aircraft_tail))).toBe(true);
    expect(a.workOrders.every((w) => events.has(w.event_id))).toBe(true);
  });
});

describe("the mission backend", () => {
  it("resolves only its own sign-ins; any other token, including an inherited property's name, is anonymous", async () => {
    expect((await resolveMissionIdentity("mission-lead-token")).subjectId).toBe(MISSION_TOKENS["mission-lead-token"]!.subjectId);
    for (const token of ["constructor", "toString", "__proto__", "nope", "", null, undefined]) expect((await resolveMissionIdentity(token)).subjectId).toBe("anonymous");
  });

  it("takes a policy change as the comparison's drift experiment makes it", async () => {
    const decide = async (backend: MissionBackend) =>
      (await backend.runtime.previewAction("UpdateWorkOrderStatus", { workOrderId: "WO-0002", status: "closed" }, MISSION_TOKENS["mission-maintainer-token"]!)).wouldExecute;
    expect(await decide(await buildMissionBackend())).toBe(false);
    expect(await decide(await buildMissionBackend({ policyOverrides: { "airforce.work-order-assignee": requireRole("maintainer") } }))).toBe(true);
  });
});

describe.each([
  ["composed", createComposedApp],
  ["handwritten", createHandwrittenApp]
] as const)("the %s application's server", (_name, create) => {
  it("serves its client under the client Content Security Policy, and says when the client is not built", async () => {
    const base = await serve(create);
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(503);
    expect(page.headers.get("content-security-policy")).toBe(CLIENT_CSP);
    const config = await call(base, "GET", "/config.json");
    expect(config.body).toEqual({ signIns: expect.arrayContaining([expect.objectContaining({ token: "mission-lead-token" })]) as unknown });
  });

  it("refuses a request from another origin", async () => {
    const base = await serve(create);
    const res = await fetch(`${base}/config.json`, { headers: { origin: "https://elsewhere.example" } });
    expect(res.status).toBe(403);
  });
});

describe("the hand-written application's own routes", () => {
  it("leaves the runtime to refuse what the caller may not do, whatever its own checks say", async () => {
    const base = await serve(createHandwrittenApp);
    const opened = await call(base, "POST", "/app/events/EVT-0102-2/work-orders", "mission-viewer-token", {});
    expect(opened.status).toBe(403);
    const updated = await call(base, "POST", "/app/work-orders/WO-0002/status", "mission-maintainer-token", { status: "closed" });
    expect(updated.status).toBe(403);
  });

  it("holds a proposal for a lead other than the person who asked, and opens and starts the work order on approval", async () => {
    const base = await serve(createHandwrittenApp);
    expect((await call(base, "POST", "/app/aircraft/AF90-0111/ground", "mission-maintainer-token", {})).body).toEqual({ status: "waiting-approval" });
    expect((await call(base, "GET", "/app/approvals", "mission-maintainer-token")).body).toEqual([]);
    expect((await call(base, "GET", "/app/approvals", "mission-viewer-token")).body).toEqual([]);
    const pending = (await call(base, "GET", "/app/approvals", "mission-lead-token")).body as { id: string; tailNumber: string }[];
    expect(pending.map((p) => p.tailNumber)).toEqual(["AF90-0111"]);
    for (const token of ["mission-maintainer-token", "mission-viewer-token", undefined]) expect((await call(base, "POST", `/app/approvals/${pending[0]!.id}`, token, {})).status).toBe(403);
    expect((await call(base, "POST", `/app/approvals/${pending[0]!.id}`, "mission-lead-token", {})).body).toEqual({ status: "completed" });
    const events = (await call(base, "GET", "/app/aircraft/AF90-0111/events", "mission-lead-token")).body as { id: string; workOrder?: { status: string } }[];
    expect(events.find((e) => e.id === "EVT-0111-1")?.workOrder?.status).toBe("in-progress");
  });
});

describe("the composed application's workflow approvals", () => {
  it("lists a run waiting on a lead for that lead only, through the governed API", async () => {
    const base = await serve(createComposedApp);
    const run = (await call(base, "POST", "/api/workflows/airforce.GroundForRepair/runs", "mission-maintainer-token", { input: { aircraftId: "AF90-0111", assignTo: "SSgt Rivera" } })).body as {
      runId: string;
      status: string;
    };
    expect(run.status).toBe("waiting-approval");
    expect((await call(base, "GET", "/api/workflow-approvals", "mission-maintainer-token")).body).toEqual([]);
    expect((await call(base, "GET", "/api/workflow-approvals", "mission-viewer-token")).body).toEqual([]);
    const forLead = (await call(base, "GET", "/api/workflow-approvals", "mission-lead-token")).body as { runId: string; presented: { tailNumber: string } }[];
    expect(forLead.map((a) => [a.runId, a.presented.tailNumber])).toEqual([[run.runId, "AF90-0111"]]);
  });
});
