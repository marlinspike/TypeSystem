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
const original = [...base.steps];
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
  it("an approval whose `when` reads the AI output cannot let the model skip its own review", async () => {
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
    expect(diagnostics.map((d) => d.code)).toContain("unreviewed-ai-output");
    await expect(engineFor(tb, w, { eventId: "EVT-9002", priority: "routine", rationale: "x" })).rejects.toThrow(/no approval of it in between/);
    expect((await workOrders(tb)).length).toBe(0);
  });

  it("the engine never skips an approval downstream of an AI step that ran, whatever its condition says", async () => {
    // Defense in depth for a definition registered without the check (an engine built from journals, say):
    // the approval's condition is ignored once the model has answered.
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const approval = step("leadApproval") as Extract<AnyStep, { kind: "approval" }>;
    const steps = base.steps.map((s) => (s.name === "leadApproval" ? { ...approval, when: () => false } : s));
    const engine = await engineFor(tb, base, { eventId: "EVT-9002", priority: "routine", rationale: "x" });
    // Swap the registered definition's steps after registration's check.
    (base as { steps: AnyStep[] }).steps.splice(0, base.steps.length, ...steps);
    try {
      const run = await engine.start(base.name, START, maintainer);
      expect({ status: run.status, workOrders: (await workOrders(tb)).length }).toEqual({ status: "waiting-approval", workOrders: 0 });
    } finally {
      (base as { steps: AnyStep[] }).steps.splice(0, base.steps.length, ...original);
    }
  });

  it("a read step cannot invoke a side-effecting Action from AI output", async () => {
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
    // A read step's body is opaque to the definition check, so the engine refuses it at run time:
    // a read step's client cannot invoke an Action.
    const engine = await engineFor(tb, w, { eventId: "EVT-9002", priority: "urgent", rationale: "x" });
    const run = await engine.start(w.name, START, maintainer);
    expect({ status: run.status, workOrders: (await workOrders(tb)).length }).toEqual({ status: "failed", workOrders: 0 });
  });

  it("a compensation with side effects fed by AI output is checked even when the step's own Action has none", async () => {
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
  it("a read step's client cannot invoke Actions for real inside simulate()", async () => {
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
    expect(result.run.status).toBe("failed"); // the read step's attempt to invoke is refused
    const rows = (await tb.registry.listAuditEvents({ limit: 1000 })).items;
    expect({ workOrders: (await workOrders(tb)).length, invoked: rows.some((e) => e.operation === "invokeAction") }).toEqual({ workOrders: 0, invoked: false });
  });
});

describe("approval presentation", () => {
  it("does not show an admitted approver data read under the initiator's clearance that the approver is not cleared for", async () => {
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
  it("an Action that took effect and then timed out leaves the run 'needs-reconciliation', not 'failed'", async () => {
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

describe("run status", () => {
  it("is shown to the initiator and an admitted approver, and to nobody else (no such run, as for a missing one)", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const engine = await engineFor(tb, base, { eventId: "EVT-9002", priority: "urgent", rationale: "x" });
    const run = await engine.start(base.name, START, maintainer);
    expect((await engine.status(run.runId, maintainer)).status).toBe("waiting-approval");
    expect((await engine.status(run.runId, lead)).status).toBe("waiting-approval");
    await expect(engine.status(run.runId, demoIdentities.viewer)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(engine.status("no-such-run", maintainer)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("listing approvals audits no denial for runs the caller merely passes by", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const engine = await engineFor(tb, base, { eventId: "EVT-9002", priority: "urgent", rationale: "x" });
    await engine.start(base.name, START, maintainer);
    const before = (await tb.registry.listAuditEvents({ limit: 10000 })).items.filter((e) => e.decision === "deny").length;
    expect(await engine.approvalsFor(demoIdentities.viewer)).toEqual([]);
    const after = (await tb.registry.listAuditEvents({ limit: 10000 })).items.filter((e) => e.decision === "deny").length;
    expect(after).toBe(before);
    expect((await engine.approvalsFor(lead)).length).toBe(1);
  });
});
