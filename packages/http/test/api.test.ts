import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSemanticValidator, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { ApiError, createClient, httpTransport, httpWorkflows, runtimeTransport, type Client, type WorkflowRun } from "@typesys/sdk";
import { WorkflowEngine, scriptedModel, type RunStatus } from "@typesys/workflow";
import { createApiApp } from "../src/index.js";

const PEOPLE = { maintainer: demoIdentities.maintainer, lead: demoIdentities.lead, viewer: demoIdentities.viewer, anonymous: demoIdentities.anonymous };
type Who = keyof typeof PEOPLE;
const token = (who: Who) => (who === "anonymous" ? undefined : `token-${who}`);
const resolve = async (t: string | null | undefined): Promise<Identity> => {
  // An identity that fails once a route uses it: a resolver that throws is a 401 instead (a refused token).
  if (t === "explode")
    return {
      subjectId: "x",
      attributes: {},
      get roles(): string[] {
        throw new Error("connection string postgres://admin:hunter2@db");
      }
    };
  const who = (Object.keys(PEOPLE) as Who[]).find((w) => token(w) === t);
  return who ? PEOPLE[who] : demoIdentities.anonymous;
};

let testbed: AirforceTestbed;
let server: Server;
let base: string;
const errors: unknown[] = [];

beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const workflows = await WorkflowEngine.create({ host: testbed, model: scriptedModel({ triage: { eventId: "EVT-9002", priority: "urgent", rationale: "Avionics fault." } }) });
  workflows.register(groundForRepair);
  const app = createApiApp({ backend: testbed, identityResolver: resolve, workflows, onError: (err) => errors.push(err) });
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, opts: { who?: Who; body?: unknown; headers?: Record<string, string> } = {}) => {
  const t = opts.who ? token(opts.who) : undefined;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...opts.headers },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
  });
  return { status: res.status, type: res.headers.get("content-type"), body: (await res.json()) as Record<string, unknown> };
};

/** A result, or the refusal's message: the two transports must agree on both. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: JSON.parse(JSON.stringify(await run(), (k, v: unknown) => (k === "retrievedAt" || k === "createdAt" ? "<t>" : v))) as unknown };
  } catch (err) {
    return { refused: (err as Error).message };
  }
}

describe("the governed REST API (ADR-0058)", () => {
  it("answers exactly as the runtime does, for every caller, through the typed SDK", async () => {
    const reads: [string, (c: Client<AirforceModel>) => Promise<unknown>][] = [
      ["query", (c) => c.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).select("tailNumber", "readinessStatus", "deploymentLocation").page()],
      ["include", (c) => c.from("airforce.Aircraft").include("maintenance", (m) => m.include("workOrder")).page()],
      ["get", (c) => c.get("airforce.Aircraft", "AF86-0147", { provenance: true })],
      ["related", (c) => c.related("airforce.Aircraft", "AF86-0147", "components")],
      ["provenance", (c) => c.provenance("airforce.Aircraft", "AF86-0147", "needsAttention")],
      ["actions", (c) => c.actions("airforce.MaintenanceEvent", "EVT-9001")],
      ["preview", (c) => c.action("CreateMaintenanceWorkOrder").preview({ maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" })],
      ["explain", (c) => c.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).explain()]
    ];
    const mismatches: unknown[] = [];
    for (const who of ["maintainer", "viewer", "anonymous"] as const) {
      const direct = createClient<AirforceModel>(runtimeTransport(testbed.runtime, PEOPLE[who]));
      const remote = createClient<AirforceModel>(httpTransport({ baseUrl: `${base}/api`, ...(token(who) ? { token: token(who)! } : {}) }));
      for (const [label, read] of reads) {
        const [a, b] = [await outcome(() => read(direct)), await outcome(() => read(remote))];
        if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ who, label, direct: a, http: b });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("refuses with a problem whose code a client can branch on, and the policy's reason", async () => {
    const viewer = createClient<AirforceModel>(httpTransport({ baseUrl: `${base}/api`, token: "token-viewer" }));
    const refused = await viewer.action("CreateMaintenanceWorkOrder").invoke({ maintenanceEventId: "EVT-9001", assignedTo: "x" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 403, code: "forbidden", reason: expect.stringMatching(/Requires one of roles/) as string });

    const bad = await call("POST", "/api/query", { who: "maintainer", body: { type: "airforce.Aircraft", limit: 0 } });
    expect(bad).toMatchObject({ status: 400, type: "application/problem+json; charset=utf-8", body: { code: "invalid-input", type: "https://typesys.dev/problems/invalid-input" } });
    expect(bad.body.errors).toBeDefined();
    expect((await call("GET", "/api/objects/airforce.Aircraft/NOPE", { who: "maintainer" })).body).toMatchObject({ status: 404, code: "not-found" });
    expect(
      (await call("POST", "/api/actions/CreateMaintenanceWorkOrder/invoke", { who: "maintainer", body: { maintenanceEventId: "EVT-NOPE", assignedTo: "x" } })).body
    ).toMatchObject({ status: 422, code: "precondition-failed" });
  });

  it("an internal error says nothing about itself to the caller", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { authorization: "Bearer explode" } });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toMatchObject({ code: "internal", detail: "Internal error" });
    expect(text).not.toMatch(/hunter2|postgres/);
    expect(String(errors.at(-1))).toMatch(/hunter2/);
  });

  it("answers only its own Host, and a browser only from an allowed Origin", async () => {
    expect((await call("GET", "/api/model", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("GET", "/api/model", { headers: { origin: base } })).status).toBe(200);
    // fetch sets Host itself; a raw request names another one.
    const { request } = await import("node:http");
    const status = await new Promise<number>((r) => request(`${base}/api/model`, { headers: { host: "rebound.example" } }, (res) => r(res.statusCode!)).end());
    expect(status).toBe(403);
  });

  it("serves discovery, query validation and the model", async () => {
    const found = await call("POST", "/api/discover", { body: { task: "close a work order", limit: 2 } });
    expect((found.body as unknown as { name: string }[])[0]?.name).toBe("UpdateWorkOrderStatus");
    const checked = await call("POST", "/api/query/validate", { body: { query: { type: "airforce.Aircrft" } } });
    expect(checked.body).toMatchObject({ diagnostics: [{ code: "unknown-type", suggestion: "airforce.Aircraft" }] });
    expect((await call("GET", "/api/model")).body).toMatchObject({ format: "typesys.model/1" });
    expect((await call("GET", "/api/me", { who: "maintainer" })).body).toEqual({ subjectId: "user-maintainer-1", roles: ["maintainer"], clearance: "SECRET" });
    expect((await call("GET", "/api/me")).body).toEqual({ subjectId: "anonymous", roles: [] });
  });

  it("runs a governed workflow over HTTP: started by one person, approved by another", async () => {
    const started = await call("POST", "/api/workflows/airforce.GroundForRepair/runs", { who: "maintainer", body: { input: { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" } } });
    expect(started).toMatchObject({ status: 201, body: { status: "waiting-approval" } });
    const runId = String(started.body.runId);
    expect((await call("POST", `/api/workflow-runs/${runId}/approvals/leadApproval`, { who: "maintainer", body: { approved: true } })).body).toMatchObject({ code: "forbidden" });
    expect((await call("GET", `/api/workflow-runs/${runId}/approval`, { who: "viewer" })).status).toBe(403);
    expect((await call("GET", `/api/workflow-runs/${runId}/approval`, { who: "lead" })).body).toMatchObject({ step: "leadApproval", presented: { tailNumber: "AF86-0147" } });
    expect((await call("POST", `/api/workflow-runs/${runId}/approvals/leadApproval`, { who: "lead", body: { approved: "yes" } })).body).toMatchObject({ code: "invalid-input" });
    expect((await call("POST", `/api/workflow-runs/${runId}/approvals/leadApproval`, { who: "lead", body: { approved: true } })).body).toMatchObject({ status: "completed" });
    expect((await call("GET", `/api/workflow-runs/${runId}/outputs`, { who: "lead" })).body).toMatchObject({ code: "forbidden" });
    expect((await call("GET", `/api/workflow-runs/${runId}/outputs`, { who: "maintainer" })).body).toHaveProperty("openWorkOrder");
    expect((await call("POST", `/api/workflow-runs/${runId}/approvals/leadApproval`, { who: "lead", body: { approved: true } })).body).toMatchObject({ status: 409, code: "conflict" });
  });
});

describe("the SDK's workflow client", () => {
  it("starts, shows, approves and reads a run as each caller, refusing as the engine does", async () => {
    // The wire type names exactly the engine's statuses.
    const toWire = (s: RunStatus): WorkflowRun["status"] => s;
    const fromWire = (s: WorkflowRun["status"]): RunStatus => s;
    void [toWire, fromWire];
    const as = (who: Who) => httpWorkflows({ baseUrl: `${base}/api`, ...(token(who) ? { token: token(who)! } : {}) });
    const run = await as("maintainer").start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" });
    expect(run).toMatchObject({ status: "waiting-approval", waitingOn: { step: "leadApproval" }, initiator: "user-maintainer-1" });
    expect((await as("lead").status(run.runId)).status).toBe("waiting-approval");
    await expect(as("viewer").status(run.runId)).rejects.toMatchObject({ status: 404 });
    await expect(as("viewer").approval(run.runId)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await as("lead").approval(run.runId)).toMatchObject({ step: "leadApproval", presented: { tailNumber: "AF86-0147" } });
    // Listed for the lead, never for its initiator or a viewer.
    expect((await as("lead").approvals()).map((a) => a.runId)).toContain(run.runId);
    expect((await as("maintainer").approvals()).map((a) => a.runId)).not.toContain(run.runId);
    expect(await as("viewer").approvals()).toEqual([]);
    expect((await as("lead").approve(run.runId, "leadApproval", { approved: true, comment: "Go" })).status).toBe("completed");
    expect((await as("lead").approvals()).map((a) => a.runId)).not.toContain(run.runId);
    expect(await as("maintainer").outputs(run.runId)).toHaveProperty("openWorkOrder");
    await expect(as("lead").outputs(run.runId)).rejects.toBeInstanceOf(ApiError);
    await expect(as("anonymous").start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "x" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the OpenAPI document (ADR-0058)", () => {
  it("is generated from the model, every reference resolves, and each Action's request schema is the one the runtime enforces", async () => {
    const doc = (await call("GET", "/api/openapi.json")).body as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { $ref: string } } } } }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) ?? [];
    const dangling = refs.map((r) => r.slice(8, -1)).filter((r) => !(r.replace("#/components/schemas/", "") in doc.components.schemas));
    expect(refs.length).toBeGreaterThan(20);
    expect(dangling).toEqual([]);

    for (const t of ["airforce.Aircraft", "airforce.WorkOrder"]) expect(doc.paths).toHaveProperty([`/objects/${t}/{id}`]);
    for (const p of ["/workflows/{name}/runs", "/workflow-runs/{id}/approvals/{step}"]) expect(doc.paths).toHaveProperty([p]);

    // Each Action's request schema, resolved within the document, admits a valid input and refuses one the runtime refuses.
    const ajv = createSemanticValidator();
    const schemas = JSON.parse(JSON.stringify(doc.components.schemas).replace(/#\/components\/schemas\//g, "#/$defs/")) as Record<string, unknown>;
    const requestOf = (action: string) =>
      ajv.compile({ $defs: schemas, $ref: doc.paths[`/actions/${action}/invoke`]!.post!.requestBody!.content["application/json"].schema.$ref.replace("#/components/schemas/", "#/$defs/") });
    const update = requestOf("UpdateWorkOrderStatus");
    expect(update({ workOrderId: "WO-1", status: "closed" })).toBe(true);
    expect(update({ workOrderId: "WO-1", status: "scrapped" })).toBe(false);
    expect(requestOf("CreateMaintenanceWorkOrder")({ maintenanceEventId: "EVT-9001" })).toBe(false);
  });
});
