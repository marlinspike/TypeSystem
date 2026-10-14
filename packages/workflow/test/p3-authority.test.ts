import { describe, it, expect } from "vitest";
import { AuthorizationError, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type TriageProposal } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, type AnyWorkflow } from "../src/index.js";

/**
 * Pressure test 3 of ADR-0065 (continuing authority). ADR-0065: "Approvals
 * are decided by the approver as they are at decision time." `cancel` and
 * `reauthorize` refuse a caller whose credentials have expired (review L4);
 * `approve` and `pendingApproval` do not check.
 */
const { maintainer, lead } = demoIdentities;
const TRIAGE: TriageProposal = { eventId: "EVT-9001", priority: "urgent", rationale: "r" };
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const T0 = Date.parse("2026-10-14T12:00:00Z");

async function fixture() {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const engine = await WorkflowEngine.create({
    host: tb,
    model: scriptedModel({ triage: TRIAGE }, "enclave", demoAudiences.enclaveModel),
    sleep: async () => {},
    now: () => new Date(T0)
  });
  engine.register({ ...(groundForRepair as unknown as AnyWorkflow), cancelPolicy: "airforce.maintenance-lead" });
  const { runId, status } = await engine.start("airforce.GroundForRepair", START, maintainer);
  expect(status).toBe("waiting-approval");
  return { tb, engine, runId };
}

const expiredLead: Identity = { ...lead, expiresAt: new Date(T0 - 60_000).toISOString() };

describe("p3: an approver's expired credentials (ADR-0065)", () => {
  it("held: cancel by a canceller whose credentials expired is refused", async () => {
    const { engine, runId } = await fixture();
    await expect(engine.cancel(runId, expiredLead, "stop")).rejects.toThrow(AuthorizationError);
  });

  it("P3-W1: approve by an approver whose credentials expired is refused, and the run keeps waiting", async () => {
    const { engine, runId } = await fixture();
    const outcome = await engine.approve(runId, "leadApproval", expiredLead, { approved: true }).then(
      (v) => v.status,
      (e: Error) => e.name
    );
    // Observed: "completed": the expired approval opened and started the work order.
    expect({ outcome, status: (await engine.status(runId)).status }).toEqual({ outcome: "AuthorizationError", status: "waiting-approval" });
  });

  it("P3-W1b: pendingApproval does not present the run's data to an approver whose credentials expired", async () => {
    const { engine, runId } = await fixture();
    await expect(engine.pendingApproval(runId, expiredLead)).rejects.toThrow(AuthorizationError);
  });
});
