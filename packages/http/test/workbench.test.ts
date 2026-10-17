import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireRole, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { createApiApp, type SubjectDirectory } from "../src/index.js";

/** The routes the workbench uses (ADR-0088, ADR-0089, ADR-0090), each decided by the runtime for the caller. */
const PEOPLE: Record<string, Identity> = { "token-lead": demoIdentities.lead, "token-viewer": demoIdentities.viewer, "token-maintainer": demoIdentities.maintainer };
const directory: SubjectDirectory = {
  list: async () => Object.values(PEOPLE).map((p) => ({ subjectId: p.subjectId })),
  resolve: async (id) => Object.values(PEOPLE).find((p) => p.subjectId === id)
};

let server: Server;
let base: string;

async function start(discovery: "open" | "need-to-know" = "open") {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery, inspection: { policy: "typesys.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
  const workflows = await WorkflowEngine.create({ host: tb, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
  workflows.register(groundForRepair);
  const app = createApiApp({
    backend: tb,
    identityResolver: async (t) => (t && PEOPLE[t]) || demoIdentities.anonymous,
    workflows,
    subjects: directory,
    consumers: [{ kind: "app", name: "board", uses: [], parts: [{ name: "data.fleet", kind: "data", uses: [{ kind: "member", type: "airforce.Aircraft", member: "maintenanceStatus", how: "select" }, { kind: "member", type: "airforce.Aircraft", member: "secretThing", how: "select" }] }] }]
  });
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}
const stop = () => new Promise<void>((r) => server.close(() => r()));

const call = async (method: string, path: string, who?: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { [k: string]: unknown } };
};

describe("workbench routes, open discovery", () => {
  beforeAll(() => start());
  afterAll(stop);

  it("inspects for an inspector and refuses anyone else", async () => {
    const ok = await call("GET", "/inspection?type=airforce.Aircraft", "token-lead");
    expect(ok.status).toBe(200);
    expect((ok.body.types as { name: string }[]).map((t) => t.name)).toEqual(["airforce.Aircraft"]);
    expect((await call("GET", "/inspection", "token-viewer")).status).toBe(403);
    expect((await call("GET", "/subjects", "token-viewer")).status).toBe(403);
    expect((await call("GET", "/subjects", "token-lead")).body).toContainEqual({ subjectId: demoIdentities.viewer.subjectId });
  });

  it("explains a caller's own read, and an inspector's question about someone else", async () => {
    const own = await call("POST", "/explain", "token-viewer", { question: { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" } });
    expect(own.body).toMatchObject({ outcome: "partial", disclosure: "caller", subject: demoIdentities.viewer.subjectId });
    const as = await call("POST", "/explain", "token-lead", { question: { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" }, as: demoIdentities.viewer.subjectId });
    expect(as.body).toMatchObject({ disclosure: "inspector", subject: demoIdentities.viewer.subjectId });
    expect(JSON.stringify(as.body)).toContain("airforce.maintainer-only");
    // A non-inspector is refused before the directory is asked, so they learn nothing of who exists.
    expect((await call("POST", "/explain", "token-viewer", { question: { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" }, as: "nobody" })).status).toBe(403);
    expect((await call("POST", "/explain", "token-lead", { question: { kind: "read", type: "airforce.Aircraft", id: "AF86-0147" }, as: "nobody" })).status).toBe(404);
    const wf = await call("POST", "/workflows/airforce.GroundForRepair/explain", "token-lead", { as: demoIdentities.viewer.subjectId });
    expect(wf.body).toMatchObject({ canStart: false, subject: demoIdentities.viewer.subjectId });
  });

  it("serves the graph from an inspection to an inspector and from the description to anyone else", async () => {
    const lead = await call("GET", "/graph?view=overview", "token-lead");
    expect(lead.body).toMatchObject({ structure: "inspection" });
    expect((lead.body.nodes as { id: string }[]).map((n) => n.id)).toEqual(expect.arrayContaining(["type:airforce.Aircraft", "workflow:airforce.GroundForRepair", "app:board", "source:mock-remis-rest"]));
    const viewer = await call("GET", "/graph?view=overview", "token-viewer");
    expect(viewer.body.structure).toBe("description");
    expect((viewer.body.nodes as { kind: string }[]).some((n) => n.kind === "policy" || n.kind === "source")).toBe(false);
    const reach = await call("GET", `/graph?view=dependents&node=${encodeURIComponent("member:airforce.Aircraft.maintenanceStatus")}`, "token-lead");
    expect(reach.body.consumers).toEqual(["app:board", "workflow:airforce.GroundForRepair"]);
    const hood = await call("GET", `/graph?view=neighborhood&node=type:airforce.Aircraft&limit=5`, "token-lead");
    expect((hood.body.nodes as unknown[]).length).toBeLessThanOrEqual(5);
    expect((await call("GET", "/graph?view=sideways", "token-lead")).status).toBe(400);
    expect((await call("GET", "/graph?view=dependents&node=type:nope", "token-lead")).status).toBe(404);
  });
});

describe("impact routes (ADR-0093)", () => {
  beforeAll(() => start());
  afterAll(stop);

  it("records a baseline as the caller may learn the model, and compares one with the model now", async () => {
    const lead = await call("GET", "/impact/baseline", "token-lead");
    const probes = lead.body.probes as { as: string; type: string; values: Record<string, string> }[];
    expect(new Set(probes.map((p) => p.as))).toEqual(new Set(Object.values(PEOPLE).map((p) => p.subjectId)));
    expect(lead.body.inspection).toBeDefined();
    const viewer = await call("GET", "/impact/baseline", "token-viewer");
    expect(new Set((viewer.body.probes as { as: string }[]).map((p) => p.as))).toEqual(new Set([demoIdentities.viewer.subjectId]));
    expect(viewer.body.inspection).toBeUndefined();
    expect((await call("POST", "/impact", "token-lead", { baseline: lead.body })).body).toMatchObject({ verdict: "compatible", items: [] });
    // A baseline in which the viewer was withheld needsAttention: now they are returned it, which is an exposure.
    const earlier = structuredClone(lead.body);
    for (const p of earlier.probes as typeof probes) if (p.as === demoIdentities.viewer.subjectId && p.type === "airforce.Aircraft") p.values.needsAttention = "withheld";
    const changed = await call("POST", "/impact", "token-lead", { baseline: earlier });
    expect((changed.body.exposures as { subject: string }[]).map((e) => e.subject)).toEqual(["airforce.Aircraft.needsAttention"]);
    expect((changed.body.exposures as { reaches: { consumers: string[] } }[])[0]!.reaches.consumers).toContain("workflow:airforce.GroundForRepair");
    expect((await call("POST", "/impact", "token-lead", { baseline: { format: "typesys.baseline/1" } })).status).toBe(400);
  });
});

describe("workbench routes, need-to-know discovery", () => {
  beforeAll(() => start("need-to-know"));
  afterAll(stop);

  it("never names, through a consumer's uses, a member the caller may not learn of", async () => {
    const viewer = await call("GET", "/graph?view=full", "token-viewer");
    const text = JSON.stringify(viewer.body);
    expect(text).not.toContain("maintenanceStatus");
    expect(text).not.toContain("secretThing");
    expect(text).toContain("app:board");
  });
});
