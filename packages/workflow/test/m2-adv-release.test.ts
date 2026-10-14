import { describe, it, expect } from "vitest";
import { withAudience, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, type AiRequest, type AnyWorkflow } from "../src/index.js";

/**
 * Adversarial checks of ADR-0067's AI-step release. Each test asserts the
 * secure behavior; a failure is a confirmed leak.
 */
const { maintainer } = demoIdentities;
const { enclaveModel, commercialModel } = demoAudiences;
const AIRCRAFT = "AF86-0147";

async function engineWith(workflow: AnyWorkflow, opts: { resolveIdentity?: (s: Identity) => Promise<Identity> } = {}) {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const calls: AiRequest[] = [];
  const engine = await WorkflowEngine.create({
    host: tb,
    model: scriptedModel({ ask: (r: AiRequest) => (calls.push(r), "ok") }, "enclave", enclaveModel),
    sleep: async () => {},
    ...opts
  });
  engine.register(workflow);
  return { tb, engine, calls };
}

const loc = (ctx: { output: <T>(n: string) => T | undefined }) => ctx.output<{ deploymentLocation?: string }>("aircraft")?.deploymentLocation;

describe("m2-adv: AI-step release (ADR-0067)", () => {
  const byInput = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
  const readInputAircraft = { kind: "read", name: "aircraft", run: async (af: unknown, ctx: { input: { id: string } }) => (af as { get: (t: string, id: string) => Promise<unknown> }).get("airforce.Aircraft", ctx.input.id) };

  it("a `when` condition over a SECRET value is not re-decided for the model, so a constant compute launders it into the model's input", async () => {
    // The maintainer reads the SECRET location; the CUI enclave model may not receive it.
    const wf = {
      name: "adv.WhenLaunder",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: byInput,
      steps: [
        readInputAircraft,
        // Runs only when the SECRET location starts with "FOB"; returns a constant, so recomputing it from what the model may receive changes nothing.
        { kind: "compute", name: "atFob", needs: ["aircraft"], when: (ctx: never) => String(loc(ctx) ?? "").startsWith("FOB"), run: () => true },
        {
          kind: "ai",
          name: "ask",
          needs: ["aircraft", "atFob"],
          prompt: "p",
          input: (ctx: { output: <T>(n: string) => T | undefined }) => ({ atFob: ctx.output("atFob") ?? false }),
          outputSchema: { type: "string" }
        }
      ]
    } as unknown as AnyWorkflow;
    const { engine, calls } = await engineWith(wf);
    const a = await engine.start("adv.WhenLaunder", { id: "AF86-0147" }, maintainer); // location "FOB ALPHA ..."
    const b = await engine.start("adv.WhenLaunder", { id: "AF86-0212" }, maintainer); // location "Home station"
    expect([a.status, b.status]).toEqual(["completed", "completed"]);
    // Secure: the model may receive neither location, so what it is sent must not depend on them.
    expect(calls.map((c) => c.input)).toEqual([{ atFob: false }, { atFob: false }]);
  });

  it("an AI step's own `when` over a SECRET value decides whether the model is called at all", async () => {
    const wf = {
      name: "adv.WhenCall",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: byInput,
      steps: [
        readInputAircraft,
        {
          kind: "ai",
          name: "ask",
          needs: ["aircraft"],
          when: (ctx: never) => String(loc(ctx) ?? "").startsWith("FOB"),
          prompt: "p",
          input: (ctx: { output: <T>(n: string) => T | undefined }) => ({ tail: ctx.output<{ tailNumber?: string }>("aircraft")?.tailNumber }),
          outputSchema: { type: "string" }
        }
      ]
    } as unknown as AnyWorkflow;
    const { engine, calls } = await engineWith(wf);
    await engine.start("adv.WhenCall", { id: "AF86-0147" }, maintainer);
    await engine.start("adv.WhenCall", { id: "AF86-0212" }, maintainer);
    // Secure: whether the model is called (and with which tail) must not depend on a value it may not receive.
    // Observed: it is called for exactly the aircraft whose SECRET location starts with FOB.
    expect(calls.map((c) => c.input)).not.toEqual([{ tail: "AF86-0147" }]);
  });

  it("a run started by an identity bound to a model keeps reading for that model after its identity is re-resolved", async () => {
    const wf: AnyWorkflow = {
      name: "adv.Rebind",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: { type: "object" },
      steps: [{ kind: "read", name: "aircraft", run: async (af: unknown) => (af as { get: (t: string, id: string) => Promise<unknown> }).get("airforce.Aircraft", AIRCRAFT) }]
    } as unknown as AnyWorkflow;
    // A directory lookup, as ADR-0065 describes resolveIdentity: it returns the person, as directories do.
    const { engine } = await engineWith(wf, { resolveIdentity: async () => maintainer });
    const agent = withAudience(maintainer, enclaveModel); // the maintainer's agent, on the enclave model (bindAudience in an HTTP/MCP host)
    const { runId, status } = await engine.start("adv.Rebind", {}, agent);
    expect(status).toBe("completed");
    const out = await engine.outputs(runId, agent);
    // Secure: the run read as maintainer+enclave, so the SECRET location is not in its output, and the agent does not receive it.
    expect(out.aircraft).not.toHaveProperty("deploymentLocation");
  });

  it("control: without resolveIdentity, the same bound run reads for the model (passes)", async () => {
    const wf = {
      name: "adv.RebindControl",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: byInput,
      steps: [readInputAircraft]
    } as unknown as AnyWorkflow;
    const { engine } = await engineWith(wf);
    const agent = withAudience(maintainer, enclaveModel);
    const { runId } = await engine.start("adv.RebindControl", { id: AIRCRAFT }, agent);
    expect((await engine.outputs(runId, agent)).aircraft).not.toHaveProperty("deploymentLocation");
  });

  it("outputs() of a run are not decided for the audience the caller reads for", async () => {
    const wf: AnyWorkflow = {
      name: "adv.Outputs",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: { type: "object" },
      steps: [{ kind: "read", name: "aircraft", run: async (af: unknown) => (af as { get: (t: string, id: string) => Promise<unknown> }).get("airforce.Aircraft", AIRCRAFT) }]
    } as unknown as AnyWorkflow;
    const { engine } = await engineWith(wf);
    // The maintainer starts the run themselves (a web UI, no model behind it).
    const { runId } = await engine.start("adv.Outputs", {}, maintainer);
    // Their agent on a commercial model, which policy grants nothing, asks for the run's outputs.
    const agent = withAudience(maintainer, commercialModel);
    let leaked: unknown;
    try {
      leaked = await engine.outputs(runId, agent);
    } catch {
      leaked = "refused";
    }
    // Secure: refused, or nothing the commercial model may not receive (it may receive no Aircraft data at all).
    expect(JSON.stringify(leaked)).not.toMatch(/deploymentLocation|tailNumber/);
  });

  it("workflow audit rows for an identity bound to an audience carry the audience", async () => {
    const wf: AnyWorkflow = {
      name: "adv.Audit",
      version: "1.0.0",
      startPolicy: "airforce.maintainer-only",
      inputSchema: { type: "object" },
      steps: [{ kind: "compute", name: "c", run: () => 1 }]
    } as unknown as AnyWorkflow;
    const { engine, tb } = await engineWith(wf);
    await engine.start("adv.Audit", {}, withAudience(maintainer, enclaveModel));
    const rows = (await tb.registry.listAuditEvents({ limit: 100 })).items.filter((e) => e.action === "workflow.start");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details?.audience).toBe(enclaveModel.id);
  });
});
