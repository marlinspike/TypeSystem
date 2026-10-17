import { describe, expect, it } from "vitest";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type TriageProposal } from "@typesys/domain-airforce";
import { WorkflowDefinitionError, WorkflowEngine, scriptedModel, simulate, type AiRequest, type AnyWorkflow } from "../src/index.js";

/**
 * An AI step may name one of the engine's models (ADR-0081): each with its
 * own audience, decided for that model alone, and a name the engine lacks is
 * refused at registration rather than at the step.
 */
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };
const base = groundForRepair as unknown as AnyWorkflow;
const naming = (model: string): AnyWorkflow => ({ ...base, version: "2.0.0", steps: base.steps.map((s) => (s.kind === "ai" ? ({ ...s, model }) : s)) });

describe("named models (ADR-0081)", () => {
  it("asks the model the step names, released for that model's audience, never the default", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const asked: string[] = [];
    const answer = (id: string) => (r: AiRequest) => (asked.push(`${id}:${r.step}`), TRIAGE);
    const engine = await WorkflowEngine.create({
      host: tb,
      sleep: async () => {},
      // The default would be refused everything (no audience); the named enclave model may receive the triage input.
      model: scriptedModel({ triage: answer("default") }, "default"),
      models: { enclave: scriptedModel({ triage: answer("enclave") }, "enclave", demoAudiences.enclaveModel) }
    });
    engine.register(naming("enclave"));
    const run = await engine.start("airforce.GroundForRepair", START, demoIdentities.maintainer);
    expect(run.status).toBe("waiting-approval");
    expect(asked).toEqual(["enclave:triage"]);
    const release = (await tb.registry.listAuditEvents({ limit: 1000 })).items.find((e) => e.action === "workflow.release");
    expect(release).toMatchObject({ decision: "allow", details: { audience: demoAudiences.enclaveModel.id } });
  });

  it("refuses to register a step that names a model the engine was not given", async () => {
    const engine = await WorkflowEngine.create({ host: await buildAirforceTestbed({ mockRestLatencyMs: 0 }), model: scriptedModel({ triage: TRIAGE }, "default", demoAudiences.enclaveModel) });
    let err: unknown;
    try {
      engine.register(naming("missing"));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkflowDefinitionError);
    expect((err as WorkflowDefinitionError).diagnostics.map((d) => d.code)).toEqual(["unknown-model"]);
  });

  it("a named model refused its input fails the step, as the default would", async () => {
    const engine = await WorkflowEngine.create({
      host: await buildAirforceTestbed({ mockRestLatencyMs: 0 }),
      sleep: async () => {},
      model: scriptedModel({ triage: TRIAGE }, "default", demoAudiences.enclaveModel),
      models: { commercial: scriptedModel({ triage: TRIAGE }, "commercial", demoAudiences.commercialModel) }
    });
    engine.register(naming("commercial"));
    const run = await engine.start("airforce.GroundForRepair", START, demoIdentities.maintainer);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.name === "triage")?.error?.name).toBe("ReleaseRefusedError");
  });

  it("a simulation answers a named step from its script", async () => {
    const result = await simulate(await buildAirforceTestbed({ mockRestLatencyMs: 0 }), naming("enclave"), {
      input: START,
      initiator: demoIdentities.maintainer,
      ai: { triage: TRIAGE },
      audience: demoAudiences.enclaveModel,
      approvals: { leadApproval: { approver: demoIdentities.lead, approved: true } }
    });
    expect(result.run.status).not.toBe("failed");
  });
});
