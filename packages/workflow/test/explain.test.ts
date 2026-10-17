import { describe, expect, it } from "vitest";
import { AuthorizationError, requireRole } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel, type AnyWorkflow } from "../src/index.js";

/** Explaining a workflow (ADR-0089): start, approvals, Actions and AI release, decided by the engine a run uses. */
async function fixture(discovery: "open" | "need-to-know" = "open") {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { discovery, inspection: { policy: "typesys.inspect" } } });
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

describe("WorkflowEngine.explain under need-to-know (5.0 pressure test)", () => {
  it("names no Action the caller is not told of, says only that a step is refused, and audits every attempt with its subject", async () => {
    const { tb, engine } = await fixture("need-to-know");
    const own = await engine.explain("airforce.GroundForRepair", demoIdentities.viewer);
    const text = JSON.stringify(own);
    expect(text).not.toContain("CreateMaintenanceWorkOrder");
    expect(text).not.toMatch(/role|maintainer/i);
    expect(own.findings.filter((f) => f.outcome === "refused" && f.basis === "evaluated" && f.control !== "discovery").every((f) => f.reason === "Not authorized")).toBe(true);
    await expect(engine.explain("airforce.GroundForRepair", demoIdentities.viewer, { as: demoIdentities.lead })).rejects.toBeInstanceOf(AuthorizationError);
    const rows = (await tb.registry.listAuditEvents({ limit: 1000 })).items.filter((r) => r.action === "workflow.explain");
    expect(rows.map((r) => [r.subjectId, r.decision, (r.details as { subject?: string }).subject])).toEqual([
      [demoIdentities.viewer.subjectId, "deny", demoIdentities.lead.subjectId],
      [demoIdentities.viewer.subjectId, "allow", demoIdentities.viewer.subjectId]
    ]);
  });
});

describe("declared reads (ADR-0090)", () => {
  const readStep = (reads: readonly string[] | undefined) => ({
    kind: "read",
    name: "aircraft",
    ...(reads ? { reads } : {}),
    run: async (af: unknown) => (af as { get: (t: string, id: string) => Promise<unknown> }).get("airforce.Aircraft", "AF86-0147")
  });
  const workflow = (name: string, reads: readonly string[] | undefined) =>
    ({ name, version: "1.0.0", startPolicy: "airforce.maintainer-only", inputSchema: { type: "object" }, steps: [readStep(reads)] }) as unknown as AnyWorkflow;

  it("lets a read step read the Types it declares, and fails it when it reads another", async () => {
    const { engine } = await fixture();
    engine.register(workflow("test.Declared", ["airforce.Aircraft"]));
    engine.register(workflow("test.Undeclared", undefined));
    engine.register(workflow("test.Wrong", ["airforce.WorkOrder"]));
    expect((await engine.start("test.Declared", {}, demoIdentities.maintainer)).status).toBe("completed");
    expect((await engine.start("test.Undeclared", {}, demoIdentities.maintainer)).status).toBe("completed");
    const wrong = await engine.start("test.Wrong", {}, demoIdentities.maintainer);
    expect(wrong.status).toBe("failed");
    expect(JSON.stringify(wrong)).toMatch(/does not declare in reads/);
  });

  it("fails a read step that follows a relationship to a Type it does not declare, through related or include (5.0 pressure test)", async () => {
    const { engine } = await fixture();
    const follows = (name: string, reads: readonly string[], run: (af: never) => Promise<unknown>) =>
      ({ name, version: "1.0.0", startPolicy: "airforce.maintainer-only", inputSchema: { type: "object" }, steps: [{ kind: "read", name: "history", reads, run }] }) as unknown as AnyWorkflow;
    const related = async (af: never) => (af as { related: (t: string, id: string, r: string) => Promise<unknown> }).related("airforce.Aircraft", "AF86-0147", "maintenance");
    const included = async (af: never) => (af as { from: (t: string) => { include: (r: string) => { page: () => Promise<unknown> } } }).from("airforce.Aircraft").include("maintenance").page();
    engine.register(follows("test.Related", ["airforce.Aircraft"], related));
    engine.register(follows("test.Included", ["airforce.Aircraft"], included));
    engine.register(follows("test.Both", ["airforce.Aircraft", "airforce.MaintenanceEvent"], related));
    for (const name of ["test.Related", "test.Included"]) {
      const run = await engine.start(name, {}, demoIdentities.maintainer);
      expect(run.status).toBe("failed");
      expect(JSON.stringify(run)).toMatch(/read Type \\"airforce.MaintenanceEvent\\", which it does not declare/);
    }
    expect((await engine.start("test.Both", {}, demoIdentities.maintainer)).status).toBe("completed");
  });

  it("refuses a definition that declares a read of an unknown Type", async () => {
    const { engine } = await fixture();
    expect(() => engine.register(workflow("test.Unknown", ["airforce.Nothing"]))).toThrow(/unknown Type "airforce.Nothing"/);
  });
});
