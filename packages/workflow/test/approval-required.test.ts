import { describe, it, expect } from "vitest";
import { AuthorizationError, describeModel, type DomainManifest } from "@typesys/core";
import { airforceManifest, buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type TriageProposal } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, simulate, validateWorkflow, type AnyWorkflow } from "../src/index.js";

/**
 * ADR-0096: an Action marked `requiresApproval` runs only from a workflow
 * step after someone other than the caller approved the run. Here the Air
 * Force domain marks CreateMaintenanceWorkOrder so; GroundForRepair already
 * opens it after the lead's approval.
 */
const { maintainer, lead } = demoIdentities;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Avionics fault." };
const manifest: DomainManifest = {
  ...airforceManifest,
  actions: airforceManifest.actions!.map((a) => (a.name === "CreateMaintenanceWorkOrder" ? { ...a, requiresApproval: true } : a))
};

async function fixture() {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, manifest });
  const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({ triage: TRIAGE }, "enclave", demoAudiences.enclaveModel), sleep: async () => {} });
  engine.register(groundForRepair);
  return { tb, engine };
}

describe("approval-required Actions (ADR-0096)", () => {
  it("refuses a direct invocation the policy admits, audits it, and says why", async () => {
    const { tb } = await fixture();
    const input = { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" };
    await expect(tb.runtime.invokeAction("CreateMaintenanceWorkOrder", input, maintainer)).rejects.toThrow(AuthorizationError);
    const preview = await tb.runtime.previewAction("CreateMaintenanceWorkOrder", input, maintainer);
    expect({ wouldExecute: preview.wouldExecute, authorized: preview.authorized, kinds: preview.blockers.map((b) => b.kind) }).toEqual({ wouldExecute: false, authorized: false, kinds: ["approval"] });
    const denied = (await tb.registry.listAuditEvents({ limit: 1000 })).items.filter((e) => e.operation === "invokeAction" && e.decision === "deny");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toMatch(/approval/);
  });

  it("refuses an approval the caller granted themselves", async () => {
    const { tb } = await fixture();
    const approval = { workflow: "airforce.GroundForRepair", runId: "r", step: "leadApproval", approvedBy: maintainer.subjectId };
    await expect(tb.runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" }, maintainer, { approval })).rejects.toThrow(AuthorizationError);
    const denied = (await tb.registry.listAuditEvents({ limit: 1000 })).items.find((e) => e.operation === "invokeAction" && e.decision === "deny");
    expect(denied?.reason).toMatch(/someone other than the caller/);
  });

  it("is described as requiring approval, and listed as not invocable directly", async () => {
    const { tb } = await fixture();
    const model = await describeModel(tb.registry);
    expect(model.actions.find((a) => a.name === "CreateMaintenanceWorkOrder")?.requiresApproval).toBe(true);
    expect(model.actions.find((a) => a.name === "UpdateWorkOrderStatus")?.requiresApproval).toBeUndefined();
  });

  it("runs from the workflow after the lead approves, and the audit names the approval", async () => {
    const { tb, engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const done = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(done.status).toBe("completed");
    const allowed = (await tb.registry.listAuditEvents({ limit: 1000 })).items.find((e) => e.operation === "invokeAction" && e.action === "CreateMaintenanceWorkOrder" && e.decision === "allow");
    expect(allowed?.details).toMatchObject({ approval: { workflow: "airforce.GroundForRepair", runId, step: "leadApproval", approvedBy: lead.subjectId } });
  });

  it("is previewed with the scripted approval when simulated", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, manifest });
    const result = await simulate(tb, groundForRepair, {
      initiator: maintainer,
      input: START,
      audience: demoAudiences.enclaveModel,
      ai: { triage: TRIAGE },
      approvals: { leadApproval: { approver: lead, approved: true } }
    });
    expect(result.run.status).toBe("completed");
  });

  it("the checker refuses a workflow that invokes it with no approval always before it", async () => {
    const { tb } = await fixture();
    const model = await describeModel(tb.registry);
    const unapproved = { ...groundForRepair, steps: groundForRepair.steps.filter((s) => s.name !== "leadApproval").map((s) => (s.name === "openWorkOrder" ? { ...s, needs: ["flagged", "proposal"] } : s)) } as unknown as AnyWorkflow;
    const codes = validateWorkflow(unapproved, model).map((d) => `${d.code}:${d.step}`);
    expect(codes).toContain("unapproved-action:openWorkOrder");
    expect(validateWorkflow(groundForRepair as unknown as AnyWorkflow, model).map((d) => d.code)).not.toContain("unapproved-action");
  });
});
