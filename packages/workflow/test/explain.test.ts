import { describe, expect, it } from "vitest";
import { AuthorizationError, requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "../src/index.js";

/** Explaining a workflow (ADR-0089): start, approvals, Actions and AI release, decided by the engine a run uses. */
async function fixture() {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { inspection: { policy: "typesys.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("typesys.inspect", requireRole("lead"));
  const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({}, "triage", demoAudiences.enclaveModel) });
  engine.register(groundForRepair);
  return { tb, engine };
}

describe("WorkflowEngine.explain (ADR-0089)", () => {
  it("tells an inspector the viewer may not start GroundForRepair and why, and that a maintainer may start it but not approve it", async () => {
    const { engine } = await fixture();
    const viewer = await engine.explain("airforce.GroundForRepair", demoIdentities.lead, { as: demoIdentities.viewer });
    expect(viewer.canStart).toBe(false);
    expect(viewer.findings[0]).toMatchObject({ about: "airforce.GroundForRepair.start", outcome: "refused", policy: "airforce.maintainer-only", rule: "role in [maintainer, ai-enclave]" });
    const maintainer = await engine.explain("airforce.GroundForRepair", demoIdentities.lead, { as: demoIdentities.maintainer });
    expect(maintainer.canStart).toBe(true);
    expect(maintainer.findings.find((f) => f.about === "airforce.GroundForRepair.leadApproval" && f.basis === "evaluated")).toMatchObject({ outcome: "refused", policy: "airforce.maintenance-lead" });
    expect(maintainer.findings.find((f) => f.about === "airforce.GroundForRepair.leadApproval" && f.basis === "structural")?.reason).toMatch(/initiator of a run may not approve it/);
    expect(maintainer.findings.find((f) => f.about === "airforce.GroundForRepair.triage")?.reason).toContain(demoAudiences.enclaveModel.id);
    expect(maintainer.findings.find((f) => f.about === "airforce.GroundForRepair.openWorkOrder")).toMatchObject({ outcome: "allowed", policy: "airforce.maintainer-only" });
  });

  it("shows a caller their own access without policy names, and refuses them anyone else's", async () => {
    const { engine } = await fixture();
    const own = await engine.explain("airforce.GroundForRepair", demoIdentities.viewer);
    expect(own.disclosure).toBe("caller");
    expect(JSON.stringify(own)).not.toContain("airforce.maintainer-only");
    await expect(engine.explain("airforce.GroundForRepair", demoIdentities.viewer, { as: demoIdentities.lead })).rejects.toBeInstanceOf(AuthorizationError);
  });
});
