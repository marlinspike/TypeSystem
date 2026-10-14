import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type AirforceTestbed, type TriageProposal } from "@typesys/domain-airforce";
import { ReleaseRefusedError, WorkflowDefinitionError, WorkflowEngine, replay, scriptedModel, simulate, type AiRequest, type AnyStep, type AnyWorkflow } from "../src/index.js";

/**
 * What an AI step may send its model (ADR-0067). The maintainer may read
 * everything below; which model receives what is decided separately, for
 * the model, at the runtime.
 */
const { maintainer, lead } = demoIdentities;
const { enclaveModel, commercialModel } = demoAudiences;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };
const base = groundForRepair as unknown as AnyWorkflow;

const withTriage = (version: string, patch: Partial<Extract<AnyStep, { kind: "ai" }>>): AnyWorkflow => ({
  ...base,
  version,
  steps: base.steps.map((s) => (s.name === "triage" ? ({ ...s, ...patch } as AnyStep) : s))
});

/** The triage step, also sending the aircraft's SECRET deployment location. */
const sendsLocation = (release?: "refuse" | "redact") =>
  withTriage("1.1.0", {
    ...(release ? { release } : {}),
    input: (ctx) => {
      const a = ctx.output<{ tailNumber?: string; deploymentLocation?: string }>("aircraft");
      return { tailNumber: a?.tailNumber, deploymentLocation: a?.deploymentLocation, history: ctx.output("history") };
    }
  });

async function engineWith(audience: typeof enclaveModel | undefined, workflow: AnyWorkflow = base, tb?: AirforceTestbed) {
  const testbed = tb ?? (await buildAirforceTestbed({ mockRestLatencyMs: 0 }));
  const calls: AiRequest[] = [];
  const engine = await WorkflowEngine.create({ host: testbed, model: scriptedModel({ triage: (r: AiRequest) => (calls.push(r), TRIAGE) }, "triage-model", audience), sleep: async () => {} });
  engine.register(workflow);
  const releases = async () => (await testbed.registry.listAuditEvents({ limit: 1000 })).items.filter((e) => e.action === "workflow.release");
  return { tb: testbed, engine, calls, releases };
}

describe("an AI step sends its model only what the model may receive (ADR-0067)", () => {
  it("the enclave model gets the triage input; the release is audited with its audience", async () => {
    const { engine, calls, releases } = await engineWith(enclaveModel);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("waiting-approval");
    expect(calls).toHaveLength(1);
    expect((await releases()).map((e) => [e.decision, e.details?.audience])).toEqual([["allow", enclaveModel.id]]);
  });

  it("a commercial model is sent nothing: the step is refused before the model is called, whoever started the run", async () => {
    const { engine, calls, releases } = await engineWith(commercialModel);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.name === "triage")?.error?.name).toBe("ReleaseRefusedError");
    expect(calls).toEqual([]);
    const [row] = await releases();
    expect(row).toMatchObject({ decision: "deny", details: { audience: commercialModel.id } });
    expect(row?.details?.withheld).toEqual(expect.arrayContaining(["aircraft", "history"]) as unknown);
  });

  it("a model with no audience is granted nothing", async () => {
    const { engine, calls } = await engineWith(undefined);
    expect((await engine.start("airforce.GroundForRepair", START, maintainer)).status).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("the maintainer may read the SECRET location; the CUI enclave model may not receive it, so a step sending it is refused", async () => {
    const { engine, calls } = await engineWith(enclaveModel, sendsLocation());
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.name === "triage")?.error?.message).toMatch(/would send model:squadron-enclave\/triage data it may not receive \(from aircraft\)/);
    expect(calls).toEqual([]);
  });

  it("with release: redact, the model is sent the step's input without what it may not receive, and the run replays", async () => {
    const { engine, calls } = await engineWith(enclaveModel, sendsLocation("redact"));
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ tailNumber: "AF86-0147" });
    expect(JSON.stringify(calls[0]!.input)).not.toMatch(/FOB|deploymentLocation/);
    // The journal records what was released, so replay checks the step against what the model was given.
    expect(() => replay(sendsLocation("redact"), runId, [])).toThrow(); // no journal, no run
    const trace = await engine.trace(runId);
    expect(() => replay(sendsLocation("redact"), runId, trace)).not.toThrow();
    expect((await engine.approve(runId, "leadApproval", lead, { approved: true })).status).toBe("completed");
  });

  it("a value derived from withheld data is withheld too: a compute over the location is recomputed from what the model may receive", async () => {
    const derived: AnyWorkflow = {
      ...base,
      version: "1.2.0",
      steps: base.steps.flatMap((s): AnyStep[] =>
        s.name === "triage"
          ? [
              { kind: "compute", name: "forward", needs: ["aircraft"], run: (ctx) => String(ctx.output<{ deploymentLocation?: string }>("aircraft")?.deploymentLocation ?? "").startsWith("FOB") },
              { ...s, needs: [...(s.needs ?? []), "forward"], input: (ctx) => ({ forward: ctx.output("forward"), history: ctx.output("history") }) } as AnyStep
            ]
          : [s]
      )
    };
    const { engine, calls } = await engineWith(enclaveModel, derived);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.name === "triage")?.error?.message).toMatch(/\(from [^)]*forward/);
    expect(calls).toEqual([]);
  });

  it("registration refuses an AI step fed by an Action's output, which cannot be released", async () => {
    const { engine } = await engineWith(enclaveModel);
    const bad: AnyWorkflow = {
      ...base,
      version: "9.0.0",
      steps: [
        { kind: "action", name: "open", action: "CreateMaintenanceWorkOrder", input: () => ({ maintenanceEventId: "EVT-9002", assignedTo: "x" }) },
        { kind: "ai", name: "summarize", needs: ["open"], prompt: "Summarize", input: (ctx) => ctx.output("open"), outputSchema: { type: "string" } }
      ]
    };
    expect(() => engine.register(bad)).toThrow(WorkflowDefinitionError);
    expect(() => engine.register(bad)).toThrow(/cannot be released to a model/);
  });

  it("a simulation releases exactly what a live run would", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const enclave = await simulate(tb, groundForRepair, { initiator: maintainer, input: START, audience: enclaveModel, ai: { triage: TRIAGE } });
    expect(enclave.run.status).toBe("waiting-approval");
    const commercial = await simulate(tb, groundForRepair, { initiator: maintainer, input: START, audience: commercialModel, ai: { triage: TRIAGE } });
    expect(commercial.run.status).toBe("failed");
    expect(commercial.trace.some((e) => e.type === "step-failed" && e.error.name === ReleaseRefusedError.name)).toBe(true);
  });
});
