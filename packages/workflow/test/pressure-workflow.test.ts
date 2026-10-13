import { describe, it, expect } from "vitest";
import { describeModel, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { WorkflowEngine, scriptedModel, simulate, validateWorkflow, type AnyStep, type AnyWorkflow } from "../src/index.js";

/**
 * Adversarial probes of @typesys/workflow (ADR-0057). Each test asserts the
 * secure / claimed behaviour; a failure is a finding.
 */
const { maintainer, lead } = demoIdentities;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const base = groundForRepair as unknown as AnyWorkflow;
const step = (name: string) => base.steps.find((s) => s.name === name)!;

async function workOrders(tb: AirforceTestbed) {
  return (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;
}

async function engineFor(tb: AirforceTestbed, w: AnyWorkflow, triage: unknown) {
  const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({ triage }), sleep: async () => {} });
  engine.register(w);
  return engine;
}

describe("AI output reaching a side effect without approval", () => {
  it("an approval whose `when` reads the AI output lets the model skip its own review", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const approval = step("leadApproval") as Extract<AnyStep, { kind: "approval" }>;
    const w: AnyWorkflow = {
      ...base,
      version: "9.0.0",
      steps: base.steps.map((s) =>
        s.name === "leadApproval"
          ? // "Only urgent proposals need a lead" -- but the model decides what is urgent.
            { ...approval, needs: [...(approval.needs ?? []), "triage"], when: (ctx) => ctx.output<{ priority: string }>("triage")?.priority !== "routine" }
          : s
      )
    };
    // The definition check accepts it ...
    const model = await describeModel(tb.registry);
    const diagnostics = validateWorkflow(w, model);
    const engine = await engineFor(tb, w, { eventId: "EVT-9002", priority: "routine", rationale: "x" });
    const run = await engine.start(w.name, START, maintainer);
    // ... and the model's answer alone opened and started a work order: no person saw it.
    expect({ status: run.status, workOrders: (await workOrders(tb)).length, diagnostics: diagnostics.map((d) => d.code) }).toEqual({
      status: "waiting-approval",
      workOrders: 0,
      diagnostics: ["unreviewed-ai-output"]
    });
  });

  it("a read step can invoke a side-effecting Action from AI output; the definition check never looks at read steps", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const w: AnyWorkflow = {
      ...base,
      version: "9.0.1",
      steps: [
        ...base.steps.filter((s) => ["aircraft", "flagged", "history", "triage"].includes(s.name)),
        {
          kind: "read",
          name: "lookup",
          needs: ["triage"],
          run: async (client, ctx) =>
            (client as unknown as ReturnType<typeof createClient<AirforceModel>>)
              .action("CreateMaintenanceWorkOrder")
              .invoke({ maintenanceEventId: ctx.output<{ eventId: string }>("triage")!.eventId, assignedTo: "SSgt Rivera" })
        }
      ]
    };
    const diagnostics = validateWorkflow(w, await describeModel(tb.registry));
    const engine = await engineFor(tb, w, { eventId: "EVT-9002", priority: "urgent", rationale: "x" });
    const run = await engine.start(w.name, START, maintainer);
    expect({ status: run.status, workOrders: (await workOrders(tb)).length, diagnostics: diagnostics.length > 0 }).toEqual({
      status: "failed",
      workOrders: 0,
      diagnostics: true
    });
  });

  it("a compensation with side effects fed by AI output is not checked when the step's own Action has none", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const real = await describeModel(tb.registry);
    // A read-only Action, as any model may declare one.
    const model = { ...real, actions: [...real.actions, { ...real.actions[0]!, name: "LookupEvent", sideEffects: "none" as const, idempotency: "natural" as const }] };
    const w: AnyWorkflow = {
      ...base,
      version: "9.0.2",
      steps: [
        ...base.steps.filter((s) => ["aircraft", "flagged", "history", "triage"].includes(s.name)),
        {
          kind: "action",
          name: "peek",
          needs: ["triage"],
          action: "LookupEvent",
          input: () => ({}),
          // Runs on any later failure: closes whatever work order the model named, with no person in between.
          compensate: { action: "UpdateWorkOrderStatus", input: (ctx: { output<T>(s: string): T | undefined }) => ({ workOrderId: ctx.output<{ eventId: string }>("triage")!.eventId, status: "closed" }) }
        } as unknown as AnyStep
      ]
    };
    expect(validateWorkflow(w, model).map((d) => d.code)).toContain("unreviewed-ai-output");
  });
});

describe("simulate has no side effects", () => {
  it("a read step's client invokes Actions for real inside simulate()", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const w: AnyWorkflow = {
      ...base,
      version: "9.1.0",
      steps: [
        {
          kind: "read",
          name: "aircraft",
          run: async (client) =>
            (client as unknown as ReturnType<typeof createClient<AirforceModel>>)
              .action("CreateMaintenanceWorkOrder")
              .invoke({ maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" })
        }
      ]
    };
    const result = await simulate(tb, w, { initiator: maintainer, input: START });
    expect(result.run.status).toBe("completed");
    const rows = (await tb.registry.listAuditEvents({ limit: 1000 })).items;
    expect({ workOrders: (await workOrders(tb)).length, invoked: rows.some((e) => e.operation === "invokeAction") }).toEqual({ workOrders: 0, invoked: false });
  });
});

describe("approval presentation", () => {
  it("shows an admitted approver data read under the initiator's clearance that the approver is not cleared for", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    // Admitted by airforce.maintenance-lead (maintainer + lead), cleared only to CUI.
    const cuiLead: Identity = { subjectId: "user-lead-cui", roles: ["maintainer", "lead"], attributes: { displayName: "TSgt Cui" }, clearance: "CUI" };
    await expect(createClient<AirforceModel>(runtimeTransport(tb.runtime, cuiLead)).get("airforce.Aircraft", START.aircraftId)).resolves.not.toHaveProperty("deploymentLocation");
    const approval = step("leadApproval") as Extract<AnyStep, { kind: "approval" }>;
    const w: AnyWorkflow = {
      ...base,
      version: "9.2.0",
      steps: base.steps.map((s) => (s.name === "leadApproval" ? { ...approval, present: undefined, needs: ["flagged", "aircraft", "proposal"] } : s))
    };
    const engine = await engineFor(tb, w, { eventId: "EVT-9002", priority: "urgent", rationale: "x" });
    const run = await engine.start(w.name, START, maintainer);
    expect(run.status).toBe("waiting-approval");
    const pending = await engine.pendingApproval(run.runId, cuiLead);
    expect(JSON.stringify(pending.presented)).not.toMatch(/deploymentLocation/);
  });
});

describe("no replay / honest status for a non-idempotent Action", () => {
  it("an Action that took effect and then timed out leaves the run 'failed', not 'needs-reconciliation'", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    // The runtime the engine sees: the write lands, then the call times out (as an adapter timeout after the write).
    const runtime = new Proxy(tb.runtime, {
      get(target, prop, receiver) {
        if (prop === "invokeAction")
          return async (...args: Parameters<typeof tb.runtime.invokeAction>) => {
            await target.invokeAction(...args);
            throw Object.assign(new Error("timed out"), { retryable: true });
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      }
    });
    const engine = await WorkflowEngine.create({ host: { ...tb, runtime }, model: scriptedModel({ triage: { eventId: "EVT-9002", priority: "urgent", rationale: "x" } }), sleep: async () => {} });
    engine.register(groundForRepair);
    const run = await engine.start(groundForRepair.name, START, maintainer);
    const done = await engine.approve(run.runId, "leadApproval", lead, { approved: true });
    expect((await workOrders(tb)).length).toBe(1); // CreateMaintenanceWorkOrder (idempotency none) did run
    expect(done.status).toBe("needs-reconciliation");
  });
});
