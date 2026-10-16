import { describe, it, expect } from "vitest";
import type { Audience, Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type TriageProposal } from "@typesys/domain-airforce";
import { WorkflowEngine, replay, type AiModel, type AiRequest, type AnyStep, type AnyWorkflow } from "../src/index.js";

/**
 * An AI step's fallback models, and what a model's answer may reach
 * (ADR-0075). Each fallback is released the step's input on its own; an
 * answer passes on only to whoever may receive everything its model was
 * given, approvers included.
 */
const { maintainer, lead } = demoIdentities;
const { enclaveModel, commercialModel } = demoAudiences;
/** An enclave model cleared SECRET: it may receive the deployment location. */
const secretModel: Audience = { ...enclaveModel, id: "model:squadron-enclave/secret", clearance: "SECRET" };
/** A second CUI enclave model, as a fallback for the first. */
const enclaveSpare: Audience = { ...enclaveModel, id: "model:squadron-enclave/spare" };
/** A maintenance lead cleared only CUI: may approve, may not read the deployment location. */
const cuiLead: Identity = { ...lead, subjectId: "user-lead-2", clearance: "CUI" };
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };
const base = groundForRepair as unknown as AnyWorkflow;
const unavailable = () => Object.assign(new Error("model unavailable"), { name: "LlmError", code: "unavailable", retryable: true });

type Answer = (r: AiRequest) => unknown;
function model(audience: Audience, answers: Record<string, Answer>, calls: string[], fallbacks: AiModel[] = []): AiModel {
  return {
    id: audience.id,
    audience,
    ...(fallbacks.length ? { fallbacks } : {}),
    complete: async (r) => {
      calls.push(`${audience.id}#${r.step}`);
      const a = answers[r.step];
      if (!a) throw new Error(`no answer for ${r.step}`);
      return a(r);
    }
  };
}

async function engineWith(m: AiModel, workflow: AnyWorkflow = base) {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const engine = await WorkflowEngine.create({ host: tb, model: m, sleep: async () => {} });
  engine.register(workflow);
  const audit = async (action: string) => (await tb.registry.listAuditEvents({ limit: 1000 })).items.filter((e) => e.action === action);
  return { tb, engine, audit };
}

/** Triage also sends the SECRET location, redacting it for a model that may not receive it. */
const triageWithLocation: AnyWorkflow = {
  ...base,
  version: "2.0.0",
  steps: base.steps.map((s) =>
    s.name === "triage"
      ? ({
          ...s,
          release: "redact",
          input: (ctx) => {
            const a = ctx.output<{ tailNumber?: string; deploymentLocation?: string }>("aircraft");
            return { tailNumber: a?.tailNumber, deploymentLocation: a?.deploymentLocation, history: ctx.output("history") };
          }
        } as AnyStep)
      : s
  )
};

describe("an AI step falls back only to a model that may receive its input (ADR-0075)", () => {
  it("an unavailable model falls back to one in the same enclave; the move is journaled and audited, and the run replays", async () => {
    const calls: string[] = [];
    const spare = model(enclaveSpare, { triage: () => TRIAGE }, calls);
    const primary = model(enclaveModel, { triage: () => Promise.reject(unavailable()) }, calls, [spare]);
    const { engine, audit } = await engineWith(primary);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("waiting-approval");
    expect(calls).toEqual([`${enclaveModel.id}#triage`, `${enclaveSpare.id}#triage`]);
    const trace = await engine.trace(run.runId);
    const started = trace.filter((e) => e.type === "step-started" && e.step === "triage");
    expect(started.map((e) => (e.type === "step-started" ? [e.model, e.released?.audience] : []))).toEqual([
      [undefined, enclaveModel.id],
      [enclaveSpare.id, enclaveSpare.id]
    ]);
    expect((await audit("workflow.fallback")).map((e) => e.details?.audience)).toEqual([enclaveSpare.id]);
    expect(() => replay(base, run.runId, trace)).not.toThrow();
  });

  it("a fallback that may not receive the input is never called: the step fails with the model's own error", async () => {
    const calls: string[] = [];
    const external = model(commercialModel, { triage: () => TRIAGE }, calls);
    const primary = model(enclaveModel, { triage: () => Promise.reject(unavailable()) }, calls, [external]);
    const { engine, audit } = await engineWith(primary);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.steps.find((s) => s.name === "triage")?.error?.message).toBe("model unavailable");
    expect(calls).toEqual([`${enclaveModel.id}#triage`]);
    expect((await audit("workflow.release")).map((e) => [e.decision, e.details?.audience])).toEqual(
      expect.arrayContaining([
        ["allow", enclaveModel.id],
        ["deny", commercialModel.id]
      ]) as unknown
    );
    expect(await audit("workflow.fallback")).toEqual([]);
  });

  it("a refused fallback is skipped for the next one that may receive the input", async () => {
    const calls: string[] = [];
    const spare = model(enclaveSpare, { triage: () => TRIAGE }, calls);
    const external = model(commercialModel, { triage: () => TRIAGE }, calls);
    const primary = model(enclaveModel, { triage: () => Promise.reject(unavailable()) }, calls, [external, spare]);
    const { engine } = await engineWith(primary);
    expect((await engine.start("airforce.GroundForRepair", START, maintainer)).status).toBe("waiting-approval");
    expect(calls).toEqual([`${enclaveModel.id}#triage`, `${enclaveSpare.id}#triage`]);
  });

  it("a failure that is not the model's availability never falls back", async () => {
    const calls: string[] = [];
    const spare = model(enclaveSpare, { triage: () => TRIAGE }, calls);
    const primary = model(enclaveModel, { triage: () => Promise.reject(new Error("bad answer")) }, calls, [spare]);
    const { engine } = await engineWith(primary);
    expect((await engine.start("airforce.GroundForRepair", START, maintainer)).status).toBe("failed");
    expect(calls).toEqual([`${enclaveModel.id}#triage`]);
  });

  it("each fallback is sent its own release: a SECRET model's fallback is sent the input without the location", async () => {
    const inputs: Record<string, unknown> = {};
    const calls: string[] = [];
    const spare = model(enclaveModel, { triage: (r) => ((inputs.spare = r.input), TRIAGE) }, calls);
    const primary = model(secretModel, { triage: (r) => ((inputs.primary = r.input), Promise.reject(unavailable())) }, calls, [spare]);
    const { engine } = await engineWith(primary, triageWithLocation);
    expect((await engine.start("airforce.GroundForRepair", START, maintainer)).status).toBe("waiting-approval");
    expect(inputs.primary).toMatchObject({ deploymentLocation: expect.any(String) as unknown });
    expect(JSON.stringify(inputs.spare)).not.toMatch(/deploymentLocation/);
  });

  it("a later AI step's fallback is not sent an earlier answer made of what it may not receive (transitive release)", async () => {
    const twoSteps: AnyWorkflow = {
      ...triageWithLocation,
      version: "2.1.0",
      steps: triageWithLocation.steps.flatMap((s): AnyStep[] =>
        s.name === "triage"
          ? [s, { kind: "ai", name: "summary", needs: ["triage"], when: (ctx) => ctx.output("triage") !== undefined, prompt: "Summarize", input: (ctx) => ctx.output("triage"), outputSchema: { type: "string" } }]
          : [s]
      )
    };
    const calls: string[] = [];
    const spare = model(enclaveModel, { summary: () => "summary" }, calls);
    const primary = model(secretModel, { triage: () => TRIAGE, summary: () => Promise.reject(unavailable()) }, calls, [spare]);
    const { engine } = await engineWith(primary, twoSteps);
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    // The triage was answered by a model given the SECRET location; the CUI fallback may not receive that answer.
    expect(run.status).toBe("failed");
    expect(calls).toEqual([`${secretModel.id}#triage`, `${secretModel.id}#summary`]);
  });
});

describe("an approver sees what the run made only as they may (ADR-0075)", () => {
  /** Adds a compute over the SECRET location that the approval presents. */
  const presentsDerived = (wf: AnyWorkflow, version: string): AnyWorkflow => ({
    ...wf,
    version,
    steps: wf.steps.flatMap((s): AnyStep[] =>
      s.name === "leadApproval"
        ? [
            { kind: "compute", name: "forward", needs: ["aircraft"], run: (ctx) => String(ctx.output<{ deploymentLocation?: string }>("aircraft")?.deploymentLocation ?? "").length > 0 },
            { ...s, needs: [...(s.needs ?? []), "forward"], present: (ctx) => ({ forward: ctx.output("forward"), proposal: ctx.output("proposal") }) } as AnyStep
          ]
        : [s]
    )
  });

  it("a compute over a value the approver may not read is withheld from them, and shown to one who may", async () => {
    const calls: string[] = [];
    const { engine } = await engineWith(model(enclaveModel, { triage: () => TRIAGE }, calls), presentsDerived(base, "3.0.0"));
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect((await engine.pendingApproval(runId, lead)).presented).toMatchObject({ forward: true, proposal: { eventId: "EVT-9002" } });
    const seen = (await engine.pendingApproval(runId, cuiLead)).presented as Record<string, unknown>;
    expect(seen.forward).toBe(false);
    expect(seen.proposal).toMatchObject({ eventId: "EVT-9002" });
  });

  it("an AI answer whose model was given the location is withheld from an approver who may not read it", async () => {
    const calls: string[] = [];
    const { engine } = await engineWith(model(secretModel, { triage: () => TRIAGE }, calls), presentsDerived(triageWithLocation, "3.1.0"));
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(((await engine.pendingApproval(runId, lead)).presented as Record<string, unknown>).proposal).toMatchObject({ eventId: "EVT-9002" });
    expect(((await engine.pendingApproval(runId, cuiLead)).presented as Record<string, unknown>).proposal).toBeUndefined();
  });

  it("an AI answer whose model was given only what the approver may read is shown to them", async () => {
    const calls: string[] = [];
    const { engine } = await engineWith(model(enclaveModel, { triage: () => TRIAGE }, calls), presentsDerived(triageWithLocation, "3.2.0"));
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(((await engine.pendingApproval(runId, cuiLead)).presented as Record<string, unknown>).proposal).toMatchObject({ eventId: "EVT-9002" });
  });
});
