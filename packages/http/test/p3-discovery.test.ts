import type { Server } from "node:http";
import { describe, it, expect, afterAll } from "vitest";
import { bindAudience, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { createApiApp } from "../src/index.js";

/**
 * Pressure test 3 over the REST API (ADR-0058) of ADR-0068 (need-to-know
 * discovery, and M7's "a refusal says it was refused, not why") and ADR-0067
 * (the release boundary for an agent's API, H1).
 */
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

async function listen(app: ReturnType<typeof createApiApp>): Promise<string> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function needToKnowApi(): Promise<string> {
  const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "need-to-know" } });
  return listen(createApiApp({ backend: testbed, identityResolver: resolveDemoIdentity, onError: () => {} }));
}

describe("p3: REST under need-to-know discovery (ADR-0068)", () => {
  it("held: GET /api/model withholds the location, maintenanceStatus and readinessStatus from the viewer, and refuses anonymous callers", async () => {
    const api = await needToKnowApi();
    const viewer = await (await fetch(`${api}/api/model`, { headers: json("demo-viewer-token") })).text();
    for (const name of ["deploymentLocation", "maintenanceStatus", "readinessStatus"]) expect(viewer).not.toContain(name);
    expect((await fetch(`${api}/api/model`, { headers: json() })).status).toBe(403);
  });

  it("P3-D5: POST /api/query/explain refuses an anonymous caller and never names what need-to-know withholds from the viewer", async () => {
    const api = await needToKnowApi();
    const body = JSON.stringify({ type: "airforce.Aircraft" });
    const anonymous = await fetch(`${api}/api/query/explain`, { method: "POST", headers: json(), body });
    const viewer = await (await fetch(`${api}/api/query/explain`, { method: "POST", headers: json("demo-viewer-token"), body })).text();
    // Observed: 200 for the anonymous caller; the viewer's plan names deploymentLocation (marked), maintenanceStatus
    // (policy-gated) and readinessStatus (computed from it), with the source system ids.
    expect({
      anonymous: anonymous.status,
      viewerNames: ["deploymentLocation", "maintenanceStatus", "readinessStatus"].filter((n) => viewer.includes(n))
    }).toEqual({ anonymous: 403, viewerNames: [] });
  });

  it("P3-D6: POST /api/actions/:name/preview does not send a policy's reason (the roles it wants) when discovery is not open", async () => {
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery: "need-to-know" } });
    const api = await listen(createApiApp({ backend: testbed, identityResolver: resolveDemoIdentity, onError: () => {} }));
    // A work order assigned to someone else: the maintainer is told of the Action (it admits them on some work order) but not on this one.
    const { id } = (await testbed.runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo: "TSgt Okafor" }, demoIdentities.lead)) as { id: string };
    const input = JSON.stringify({ workOrderId: id, status: "closed" });
    const invoke = await fetch(`${api}/api/actions/UpdateWorkOrderStatus/invoke`, { method: "POST", headers: json("demo-maintainer-token"), body: input });
    const invokeText = await invoke.text();
    // Held (M7): the invocation's refusal does not say why.
    expect(invoke.status).toBe(403);
    expect(invokeText).not.toContain("roles");
    const preview = await fetch(`${api}/api/actions/UpdateWorkOrderStatus/preview`, { method: "POST", headers: json("demo-maintainer-token"), body: input });
    const previewText = await preview.text();
    // Observed: 200 with blocker "No alternative allowed: Requires one of roles [lead], subject has [maintainer]; Requires resource.assignedTo to match subject.displayName".
    expect(previewText).not.toMatch(/roles|assignedTo|displayName/);
  });
});

describe("p3: the run's progress, to an agent bound to a model (ADR-0067)", () => {
  it("P3-RL2: GET /api/workflow-runs/:id tells a commercial-model agent nothing it may not receive about the aircraft", async () => {
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const engine = await WorkflowEngine.create({ host: testbed, model: scriptedModel({ triage: { eventId: "EVT-9001", priority: "urgent", rationale: "x" } }, "enclave", demoAudiences.enclaveModel) });
    engine.register(groundForRepair);
    const resolve = async (t: string | null | undefined): Promise<Identity> => (t === "maintainer" ? demoIdentities.maintainer : demoIdentities.anonymous);
    const ui = await listen(createApiApp({ backend: testbed, identityResolver: resolve, workflows: engine, onError: () => {} }));
    const agent = await listen(createApiApp({ backend: testbed, identityResolver: bindAudience(resolve, demoAudiences.commercialModel), workflows: engine, onError: () => {} }));
    const headers = json("maintainer");

    const views: unknown[] = [];
    for (const aircraftId of ["AF86-0147", "AF86-0212"]) {
      const started = await fetch(`${ui}/api/workflows/airforce.GroundForRepair/runs`, { method: "POST", headers, body: JSON.stringify({ input: { aircraftId, assignTo: "SSgt Rivera" } }) });
      const { runId } = (await started.json()) as { runId: string };
      // Held (H1): the agent may not read the aircraft or the run's outputs.
      expect((await fetch(`${agent}/api/objects/airforce.Aircraft/${aircraftId}`, { headers })).status).toBe(403);
      expect((await fetch(`${agent}/api/workflow-runs/${runId}/outputs`, { headers })).status).toBe(403);
      const res = await fetch(`${agent}/api/workflow-runs/${runId}`, { headers });
      const view = res.status === 200 ? ((await res.json()) as { status: string; steps: { name: string; status: string }[] }) : undefined;
      views.push(view ? { status: view.status, steps: view.steps.map((s) => `${s.name}:${s.status}`) } : res.status);
    }
    // The commercial model may receive nothing of either aircraft, so what it is told of the two runs must not differ.
    // Observed: one run is waiting-approval with every step run, the other completed with every step after "flagged"
    // skipped, which tells the model which aircraft needs attention.
    expect(views[0]).toEqual(views[1]);
  });
});
