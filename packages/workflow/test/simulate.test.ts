import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SemanticRuntime, DEMO_LINEAR_CLASSIFICATION, type Identity, type PolicyEngine } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { CedarPolicyEngine } from "@typesys/policy-cedar";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { WorkflowEngine, scriptedModel, simulate } from "../src/index.js";

const { maintainer, lead, viewer } = demoIdentities;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE = { eventId: "EVT-9002", priority: "urgent", rationale: "Avionics fault." };

async function counts(tb: AirforceTestbed) {
  const items = (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;
  return items.length;
}

describe("simulate (ADR-0057)", () => {
  it("runs the whole workflow with reads for real, Actions previewed, and nothing changed", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const result = await simulate(tb, groundForRepair, {
      initiator: maintainer,
      input: START,
      ai: { triage: TRIAGE },
      approvals: { leadApproval: { approver: lead, approved: true } }
    });
    expect(result.run.status).toBe("completed");
    expect(result.run.simulation).toBe(true);
    expect(await counts(tb)).toBe(0);

    const completed = result.trace.filter((e) => e.type === "step-completed");
    const open = completed.find((e) => e.step === "openWorkOrder")!;
    expect(open).toMatchObject({ source: "action", simulated: { wouldExecute: true }, output: { maintenanceEventId: "EVT-9002", status: expect.any(String) as string } });
    // The work order it would start does not exist, so its preview is reported as unchecked, never as a pass.
    expect(completed.find((e) => e.step === "startWork")).toMatchObject({ simulated: { wouldExecute: null } });

    const rows = (await tb.registry.listAuditEvents({ limit: 1000 })).items;
    expect(rows.some((e) => e.operation === "previewAction" && e.action === "CreateMaintenanceWorkOrder")).toBe(true);
    expect(rows.some((e) => e.operation === "invokeAction")).toBe(false);
    expect(rows.filter((e) => e.operation === "workflow").every((e) => e.details?.simulation === true)).toBe(true);
  });

  it("shows a run that would be refused, where, and why", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    // The script says the viewer approves; the policy decides for real, and refuses.
    const refused = await simulate(tb, groundForRepair, {
      initiator: maintainer,
      input: START,
      ai: { triage: TRIAGE },
      approvals: { leadApproval: { approver: viewer, approved: true } }
    });
    expect(refused.run.status).toBe("waiting-approval");
    expect(refused.refusals).toEqual([{ step: "leadApproval", message: expect.stringMatching(/Requires one of roles/) as string }]);

    const noModel = await simulate(tb, groundForRepair, { initiator: maintainer, input: START });
    expect(noModel.run.status).toBe("failed");
    expect(noModel.run.reason).toMatch(/No scripted answer for AI step "triage"/);
  });

  it("injects faults, recovers from crashes from the journal, and reports what it could not finish", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const result = await simulate(tb, groundForRepair, {
      initiator: maintainer,
      input: START,
      ai: { triage: TRIAGE },
      approvals: { leadApproval: { approver: lead, approved: true } },
      faults: { history: [{ attempt: 1, crash: "before-effect" }], openWorkOrder: [{ crash: "after-effect" }] }
    });
    expect(result.crashes).toEqual(['Simulated crash at step "history" (before-effect)', 'Simulated crash at step "openWorkOrder" (after-effect)']);
    expect(result.run.status).toBe("needs-reconciliation");
    expect(result.run.steps.find((s) => s.name === "history")?.attempts).toBe(2);
  });
});

describe("workflow decisions under Cedar match the ABAC rules (ADR-0031, ADR-0057)", () => {
  const SCHEMA = readFileSync(new URL("../../policy-cedar/examples/demo-domains.cedarschema", import.meta.url), "utf8");
  const POLICIES = readFileSync(new URL("../../policy-cedar/examples/demo-domains.cedar", import.meta.url), "utf8");
  const IDENTITIES: Identity[] = [
    maintainer,
    lead,
    viewer,
    demoIdentities.anonymous,
    { subjectId: "lead-only", roles: ["lead"], attributes: {} },
    { subjectId: "spoof", roles: ["Lead", "lead ", 'maintainer"'], attributes: {} }
  ];

  it("starts and approvals decide identically, for every identity", async () => {
    const outcomes = async (engineFor: (tb: AirforceTestbed) => PolicyEngine) => {
      const lines: string[] = [];
      for (const who of IDENTITIES) {
        const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
        const policyEngine = engineFor(tb);
        const runtime = new SemanticRuntime(tb.registry, [tb.inMemoryAdapter, tb.mockRestAdapter], policyEngine, { classification: DEMO_LINEAR_CLASSIFICATION });
        const engine = await WorkflowEngine.create({ host: { registry: tb.registry, runtime, policyEngine }, model: scriptedModel({ triage: TRIAGE }) });
        engine.register(groundForRepair);
        const start = await engine.start("airforce.GroundForRepair", START, who).then((r) => r.status, (e: Error) => e.name);
        const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
        const approve = await engine.approve(runId, "leadApproval", who, { approved: true }).then((r) => r.status, (e: Error) => e.name);
        lines.push(`${who.subjectId}: start ${start}, approve ${approve}`);
      }
      return lines;
    };
    const abac = await outcomes((tb) => tb.policyEngine);
    const cedar = await outcomes(() => new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES }));
    expect(cedar).toEqual(abac);
    expect(abac).toEqual([
      "user-maintainer-1: start waiting-approval, approve AuthorizationError",
      "user-lead-1: start waiting-approval, approve completed",
      "user-viewer-1: start AuthorizationError, approve AuthorizationError",
      "anonymous: start AuthorizationError, approve AuthorizationError",
      "lead-only: start AuthorizationError, approve AuthorizationError",
      "spoof: start AuthorizationError, approve AuthorizationError"
    ]);
  });
});
