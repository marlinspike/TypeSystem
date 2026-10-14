import { describe, expect, it } from "vitest";
import { AuthorizationError, withAudience, type PolicyDecision, type PolicyEngine, type PolicyRequest } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type TriageProposal } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, type AnyWorkflow } from "../src/index.js";

/**
 * Independent review (P3) of the workflow engine's own policy decisions
 * (start, approval, cancel) through `decideForIdentity` (packages/core/src/model/policy.ts).
 * The read path's fail-closed handling is tested in core; this path had no
 * test, so a hand-made mutation making a throwing engine *allow*, or a
 * truthy non-boolean `allow` count, survived the whole suite. These tests
 * pass on the current code and kill both mutations. The audience half of
 * the same function (ADR-0067: both the person and the audience must allow)
 * likewise had no test: dropping it survived the whole suite.
 */
const { maintainer, lead } = demoIdentities;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };

type Mode = "real" | "throws" | "malformed";

async function fixture() {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const state: { mode: Mode } = { mode: "real" };
  const policyEngine: PolicyEngine = {
    evaluate: async (request: PolicyRequest): Promise<PolicyDecision> => {
      if (state.mode === "throws") throw new Error("policy store unreachable");
      if (state.mode === "malformed") return { allow: "yes" as unknown as boolean };
      return tb.policyEngine.evaluate(request);
    }
  };
  const engine = await WorkflowEngine.create({
    sleep: async () => {},
    host: { ...tb, policyEngine },
    model: scriptedModel({ triage: TRIAGE }, "test-model", demoAudiences.enclaveModel)
  });
  engine.register({ ...(groundForRepair as unknown as AnyWorkflow), cancelPolicy: "airforce.maintenance-lead" });
  return { engine, state };
}

describe("P3: the workflow engine's own decisions fail closed (ADR-0065)", () => {
  for (const mode of ["throws", "malformed"] as const) {
    it(`P3-M2: a policy engine that ${mode === "throws" ? "throws" : "answers allow: \"yes\""} cannot start a run`, async () => {
      const { engine, state } = await fixture();
      state.mode = mode;
      await expect(engine.start("airforce.GroundForRepair", START, maintainer)).rejects.toThrow(AuthorizationError);
    });

    it(`P3-M2: a policy engine that ${mode === "throws" ? "throws" : "answers allow: \"yes\""} cannot approve a waiting run`, async () => {
      const { engine, state } = await fixture();
      const { runId, status } = await engine.start("airforce.GroundForRepair", START, maintainer);
      expect(status).toBe("waiting-approval");
      state.mode = mode;
      await expect(engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(AuthorizationError);
      state.mode = "real";
      expect((await engine.status(runId)).status).toBe("waiting-approval");
    });
  }

  it("P3-M3: an identity bound to an audience the start policy does not admit cannot start a run (ADR-0067)", async () => {
    const { engine } = await fixture();
    await expect(engine.start("airforce.GroundForRepair", START, withAudience(maintainer, demoAudiences.commercialModel))).rejects.toThrow(AuthorizationError);
  });

  it("P3-M3: an approver bound to an audience the approval policy does not admit cannot approve (ADR-0067)", async () => {
    const { engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(engine.approve(runId, "leadApproval", withAudience(lead, demoAudiences.commercialModel), { approved: true })).rejects.toThrow(AuthorizationError);
    expect((await engine.status(runId)).status).toBe("waiting-approval");
  });
});
