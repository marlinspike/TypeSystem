import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHost, parseMission, planMission, scaffoldMission, verifyMission, type MissionSpec } from "../src/index.js";

/**
 * The engineering loop end to end (ADR-0071), on the component-replacement
 * mission: plan, scaffold, verify; then a defect seeded in the spec and one
 * seeded in the application, each found by a diagnostic an agent can act
 * on, repaired, and verified again.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const MISSION = path.resolve(pkg, "../../examples/missions/component-replacement/mission.json");
const WORK = path.join(pkg, ".work", "loop-test");
const doc = JSON.parse(readFileSync(MISSION, "utf8")) as MissionSpec;

describe("the engineering loop (ADR-0071)", () => {
  it("plans the example mission against the airforce model with no error, and says who is told of what", async () => {
    const { spec } = parseMission(doc);
    expect(spec).toBeDefined();
    const { host, resolve, workflows } = await loadHost(spec!, pkg);
    const plan = await planMission(spec!, host, resolve, workflows);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.provided.types.map((t) => t.name)).toEqual(["airforce.Aircraft", "airforce.Component", "airforce.MaintenanceEvent"]);
    expect(plan.provided.relationships).toContainEqual({ from: "airforce.Aircraft", name: "components", target: "airforce.Component", cardinality: expect.any(String) as string });
    expect(plan.provided.workflows.map((w) => w.name)).toEqual(["airforce.GroundForRepair"]);
    expect(plan.create.map((f) => f.file)).toEqual(["mission.json", "model.ts", "workflow.ts", "views.tsx", "server.ts", "acceptance.test.ts", "index.html", "tsconfig.json"]);
  });

  it("finds a defect seeded in the spec before anything is written: an unknown Type, with the near miss as its fix", async () => {
    const typo = { ...doc, uses: { ...doc.uses, types: ["airforce.Aircraft", "airforce.Componnet"] } };
    const { host, resolve } = await loadHost(doc, pkg);
    const plan = await planMission(typo, host, resolve);
    expect(plan.ok).toBe(false);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-type", at: "uses/types/1", hint: 'did you mean "airforce.Component"?' }));

    const field = { ...doc, views: [{ ...doc.views![0]!, fields: ["name", "condtion"] }] };
    const fieldPlan = await planMission(field, host, resolve);
    expect(fieldPlan.ok).toBe(false);
    expect(fieldPlan.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-field", at: "views/0", hint: 'did you mean "condition"?' }));
  });

  it("a self-approval written into the spec is warned by plan and fails verify; so does a check the model's policy contradicts", { timeout: 180_000 }, async () => {
    const dir = path.join(pkg, ".work", "loop-test-spec-defects");
    await rm(dir, { recursive: true, force: true });
    const steps = doc.workflow!.steps.map((s) => (s.kind === "approval" ? { ...s, allowSelfApproval: true } : s));
    const acceptance = doc.acceptance.map((c) => (c.id === "viewer-lacks-maintenance-status" ? { ...c, withheld: ["tailNumber"] } : c));
    const defective: MissionSpec = { ...doc, workflow: { ...doc.workflow!, steps }, acceptance };
    const { host, resolve } = await loadHost(defective, pkg);
    expect((await planMission(defective, host, resolve)).diagnostics).toContainEqual(expect.objectContaining({ code: "self-approval", severity: "warning" }));
    await scaffoldMission(defective, host, dir);
    const report = await verifyMission(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(["lead-cannot-approve-own-request", "viewer-lacks-maintenance-status"]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: "check-failed", message: expect.stringMatching(/sees tailNumber, which must be withheld/) as string }));
  });

  it("refuses a mission workflow that would shadow one the host already runs", async () => {
    const { host, resolve, workflows } = await loadHost(doc, pkg);
    const shadow = { ...doc, workflow: { ...doc.workflow!, name: "airforce.GroundForRepair" }, acceptance: doc.acceptance.filter((c) => c.kind !== "starts" && c.kind !== "approves") };
    const plan = await planMission(shadow, host, resolve, workflows);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code: "workflow-exists", at: "workflow/name" }));
    expect(plan.ok).toBe(false);
  });

  it("scaffolds an application that verifies; a self-approval defect seeded into it fails verify with a diagnostic; repaired, it verifies again", { timeout: 180_000 }, async () => {
    await rm(WORK, { recursive: true, force: true });
    const { host } = await loadHost(doc, pkg);
    await scaffoldMission(doc, host, WORK);

    const first = await verifyMission(WORK);
    expect(first.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(first).toMatchObject({ ok: true, stages: { plan: true, build: true, checks: true } });
    expect(first.checks).toHaveLength(doc.acceptance.length);

    // The defect an agent might write: the approval admits the requester.
    const workflowFile = path.join(WORK, "workflow.ts");
    const generated = await readFile(workflowFile, "utf8");
    const seeded = generated.replace('policy: "airforce.maintenance-lead",', 'policy: "airforce.maintenance-lead",\n      allowSelfApproval: true,');
    expect(seeded).not.toBe(generated);
    await writeFile(workflowFile, seeded);
    const broken = await verifyMission(WORK);
    expect(broken).toMatchObject({ ok: false, stages: { plan: true, build: true, checks: false } });
    expect(broken.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["lead-cannot-approve-own-request"]);
    expect(broken.diagnostics).toContainEqual(
      expect.objectContaining({ code: "check-failed", at: `acceptance/${doc.acceptance.findIndex((c) => c.id === "lead-cannot-approve-own-request")}`, hint: expect.stringMatching(/allowSelfApproval/) as string })
    );

    // A defect that does not compile is a diagnostic at its file and line, not a crash.
    await writeFile(workflowFile, generated.replace('action: "CreateMaintenanceWorkOrder",', 'action: "CreateMaintenanceWorkOrder",\n      retry: { maxAttempts: "3" },'));
    const unbuilt = await verifyMission(WORK);
    expect(unbuilt).toMatchObject({ ok: false, stages: { plan: true, build: false } });
    expect(unbuilt.diagnostics[0]).toMatchObject({ code: "compile-error", at: expect.stringMatching(/^workflow\.ts:\d+:\d+$/) as string });

    // The repair the diagnostic points at.
    await writeFile(workflowFile, generated);
    const repaired = await verifyMission(WORK);
    expect(repaired).toMatchObject({ ok: true, stages: { plan: true, build: true, checks: true } });
  });
});
