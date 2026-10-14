import type { Server } from "node:http";
import { describe, it, expect, afterAll } from "vitest";
import { bindAudience, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { createApiApp } from "../src/index.js";

/**
 * ADR-0067 over HTTP: an API an agent talks through is bound to the agent's
 * model with bindAudience. Every answer it gives must be what both the user
 * and that model may read.
 */
const servers: Server[] = [];
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

const resolve = async (t: string | null | undefined): Promise<Identity> => (t === "maintainer" ? demoIdentities.maintainer : demoIdentities.anonymous);

async function listen(app: ReturnType<typeof createApiApp>): Promise<string> {
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("m2-adv: HTTP API bound to a model (ADR-0067)", () => {
  it("a commercial-model agent reads a run's outputs, SECRET location included, though it may read no Aircraft", async () => {
    const testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const engine = await WorkflowEngine.create({ host: testbed, model: scriptedModel({ triage: { eventId: "EVT-9002", priority: "urgent", rationale: "x" } }, "enclave", demoAudiences.enclaveModel) });
    engine.register(groundForRepair);
    // One engine, two front doors: the people's UI, and the API the maintainer's agent (on a commercial model) talks through.
    const ui = await listen(createApiApp({ backend: testbed, identityResolver: resolve, workflows: engine, onError: () => {} }));
    const agent = await listen(createApiApp({ backend: testbed, identityResolver: bindAudience(resolve, demoAudiences.commercialModel), workflows: engine, onError: () => {} }));
    const headers = { "content-type": "application/json", authorization: "Bearer maintainer" };

    const started = await fetch(`${ui}/api/workflows/airforce.GroundForRepair/runs`, { method: "POST", headers, body: JSON.stringify({ input: { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" } }) });
    const { runId } = (await started.json()) as { runId: string };

    // The agent is refused the aircraft directly: the commercial model may receive none of it.
    const direct = await fetch(`${agent}/api/objects/airforce.Aircraft/AF86-0147`, { headers });
    expect(direct.status).toBe(403);

    // Secure: the run's outputs are refused, or decided for the agent's model, too.
    const outputs = await fetch(`${agent}/api/workflow-runs/${runId}/outputs`, { headers });
    const text = await outputs.text();
    expect({ status: outputs.status, leaksLocation: text.includes("FOB ALPHA") }).toEqual({ status: 403, leaksLocation: false });
  });
});
