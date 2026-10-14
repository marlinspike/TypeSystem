import { describe, it, expect } from "vitest";
import { AdapterUnavailableError, AuthorizationError, InvalidInputError, describeModel, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed, type TriageProposal } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import {
  InMemoryJournal,
  JournalConflictError,
  ReplayDivergenceError,
  WorkflowDefinitionError,
  WorkflowEngine,
  WorkflowStateError,
  replay,
  scriptedModel,
  validateWorkflow,
  type AiRequest,
  type AnyWorkflow,
  type WorkflowEngineOptions
} from "../src/index.js";

const { maintainer, lead, viewer } = demoIdentities;
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault reported by the crew chief." };
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };

async function fixture(opts: Partial<WorkflowEngineOptions> & { triage?: unknown } = {}) {
  const tb = opts.host ? (opts.host as AirforceTestbed) : await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const calls: AiRequest[] = [];
  const sleeps: number[] = [];
  const answer = "triage" in opts ? opts.triage : TRIAGE;
  const model = opts.model ?? scriptedModel({ triage: (r: AiRequest) => (calls.push(r), typeof answer === "function" ? (answer as () => unknown)() : answer) }, "test-model", demoAudiences.enclaveModel);
  const engine = await WorkflowEngine.create({ sleep: async (ms) => void sleeps.push(ms), ...opts, host: tb, model });
  engine.register(groundForRepair);
  return { tb, engine, calls, sleeps };
}

/** Every work order, as a lead reads them. */
async function workOrders(tb: AirforceTestbed) {
  return (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;
}

async function audit(tb: AirforceTestbed) {
  return (await tb.registry.listAuditEvents({ limit: 1000 })).items;
}

/** A variant of the demo workflow, as a new version. */
function variant(version: string, change: (steps: AnyWorkflow["steps"]) => AnyWorkflow["steps"]): AnyWorkflow {
  const w = groundForRepair as unknown as AnyWorkflow;
  return { ...w, version, steps: change(w.steps) };
}

describe("a governed run, end to end (ADR-0057)", () => {
  it("reads as the initiator, waits for a lead, then opens and starts the work order", async () => {
    const { tb, engine, calls } = await fixture();
    const started = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(started.status).toBe("waiting-approval");
    expect(started.waitingOn).toEqual({ step: "leadApproval", policy: "airforce.maintenance-lead" });
    expect(await workOrders(tb)).toHaveLength(0);

    // The model saw only what the step gave it: no SECRET deploymentLocation, no maintenanceStatus.
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]!.input)).not.toMatch(/deploymentLocation|FOB/);
    expect(calls[0]!.input).toMatchObject({ aircraft: { tailNumber: "AF86-0147", readinessStatus: "PMC" } });

    const pending = await engine.pendingApproval(started.runId, lead);
    expect(pending.presented).toMatchObject({ tailNumber: "AF86-0147", proposal: { eventId: "EVT-9002", event: { id: "EVT-9002" } } });

    const done = await engine.approve(started.runId, "leadApproval", lead, { approved: true, comment: "Ground it." });
    expect(done.status).toBe("completed");
    expect(done.steps.map((s) => [s.name, s.status, s.source])).toEqual([
      ["aircraft", "completed", "read"],
      ["flagged", "completed", "compute"],
      ["history", "completed", "read"],
      ["triage", "completed", "model"],
      ["proposal", "completed", "compute"],
      ["leadApproval", "completed", "human"],
      ["openWorkOrder", "completed", "action"],
      ["startWork", "completed", "action"]
    ]);
    const [order] = await workOrders(tb);
    expect(order).toMatchObject({ maintenanceEventId: "EVT-9002", status: "in-progress", assignedTo: "SSgt Rivera" });

    // The Actions were the initiator's, audited by the runtime as theirs; the run's own rows are the engine's.
    const rows = await audit(tb);
    expect(rows.find((e) => e.action === "CreateMaintenanceWorkOrder" && e.outcome === "success")?.subjectId).toBe(maintainer.subjectId);
    expect(rows.filter((e) => e.operation === "workflow").reverse().map((e) => [e.action, e.subjectId, e.decision])).toEqual([
      ["workflow.start", maintainer.subjectId, "allow"],
      // What the triage model was sent, released to its audience (ADR-0067).
      ["workflow.release", maintainer.subjectId, "allow"],
      ["workflow.view-approval", lead.subjectId, "allow"],
      ["workflow.approve", lead.subjectId, "allow"],
      ["workflow.finish", maintainer.subjectId, "allow"]
    ]);
  });

  it("skips everything after the check when the aircraft needs no attention, and never calls the model", async () => {
    const { tb, engine, calls } = await fixture();
    const run = await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0212", assignTo: "SSgt Rivera" }, maintainer);
    expect(run.status).toBe("completed");
    expect(run.steps.filter((s) => s.status === "skipped").map((s) => s.name)).toEqual(["history", "triage", "proposal", "leadApproval", "openWorkOrder", "startWork"]);
    expect(calls).toHaveLength(0);
    expect(await workOrders(tb)).toHaveLength(0);
  });

  it("refuses a caller the start policy does not admit, and input the schema does not", async () => {
    const { tb, engine } = await fixture();
    await expect(engine.start("airforce.GroundForRepair", START, viewer)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await audit(tb)).some((e) => e.action === "workflow.start" && e.decision === "deny" && e.subjectId === viewer.subjectId)).toBe(true);
    await expect(engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147" }, maintainer)).rejects.toBeInstanceOf(InvalidInputError);
    expect(await engine.journal.runs()).toHaveLength(0);
  });

  it("keeps outputs for the initiator, the approval for an admitted approver, and lets anyone see only where a run is", async () => {
    const { engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(Object.keys(await engine.outputs(runId, maintainer))).toContain("triage");
    await expect(engine.outputs(runId, lead)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(engine.pendingApproval(runId, viewer)).rejects.toBeInstanceOf(AuthorizationError);
    expect(JSON.stringify(await engine.status(runId))).not.toMatch(/EVT-9002|avionics|PMC/);
  });
});

describe("approvals are decided by policy, and by someone else", () => {
  it("refuses the initiator approving their own run, and an approver the policy does not admit", async () => {
    const { tb, engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, lead); // a lead may start, but then not approve
    await expect(engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toMatchObject({ reason: expect.stringMatching(/may not approve/) as string });
    const otherMaintainer: Identity = { subjectId: "user-maintainer-2", roles: ["maintainer"], attributes: {} };
    await expect(engine.approve(runId, "leadApproval", otherMaintainer, { approved: true })).rejects.toBeInstanceOf(AuthorizationError);
    const denials = (await audit(tb)).filter((e) => e.action === "workflow.approve" && e.decision === "deny");
    expect(denials.map((e) => e.subjectId).reverse()).toEqual([lead.subjectId, otherMaintainer.subjectId]);
    expect((await engine.status(runId)).status).toBe("waiting-approval");
  });

  it("a rejection ends the run with nothing invoked", async () => {
    const { tb, engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: false, comment: "Fly it to depot instead." });
    expect(run.status).toBe("rejected");
    expect(run.reason).toBe(`Approval "leadApproval" was rejected by ${lead.subjectId}`);
    expect(await workOrders(tb)).toHaveLength(0);
  });

  it("two concurrent decisions: exactly one is recorded", async () => {
    const { engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const lead2: Identity = { ...lead, subjectId: "user-lead-2" };
    const results = await Promise.allSettled([
      engine.approve(runId, "leadApproval", lead, { approved: true }),
      engine.approve(runId, "leadApproval", lead2, { approved: false })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(JournalConflictError);
    expect((await engine.trace(runId)).filter((e) => e.type === "approval-decided")).toHaveLength(1);
  });

  it("lists for each approver only the runs waiting on an approval they may give, and never hides a broken one", async () => {
    const journal = new InMemoryJournal();
    const { engine } = await fixture({ journal, faults: { startWork: [{ crash: "after-effect", attempt: 1 }] } });
    const waiting = await engine.start("airforce.GroundForRepair", START, maintainer);
    const crashed = await engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(engine.approve(crashed.runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/Simulated crash/);
    const rejected = await engine.start("airforce.GroundForRepair", START, maintainer);
    await engine.approve(rejected.runId, "leadApproval", lead, { approved: false });
    // Left mid-flight by the crash, and finished by the rejection: neither waits on anyone.
    expect((await engine.approvalsFor(lead)).map((a) => a.runId)).toEqual([waiting.runId]);
    expect(await engine.approvalsFor(maintainer)).toEqual([]);
    expect(await engine.approvalsFor(viewer)).toEqual([]);

    // A presentation that fails is an error to see, not an approval silently missing from the list.
    const broken = variant("2.0.0", (steps) => steps.map((st) => (st.kind === "approval" ? { ...st, present: () => { throw new Error("present failed"); } } : st)));
    engine.register(broken);
    await engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(engine.approvalsFor(lead)).rejects.toThrow(/present failed/);
  });

  it("approving a run that is not waiting on that step is refused", async () => {
    const { engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(engine.approve(runId, "openWorkOrder", lead, { approved: true })).rejects.toBeInstanceOf(WorkflowStateError);
  });
});

describe("the model's answer is checked, never trusted", () => {
  it("an answer outside the output schema fails the step (and is retried when the step allows)", async () => {
    let n = 0;
    const answers = [{ eventId: "EVT-9002", priority: "whenever", rationale: "x" }, TRIAGE];
    const { engine } = await fixture({ triage: () => answers[n++] });
    engine.register(variant("1.1.0", (steps) => steps.map((s) => (s.name === "triage" ? { ...s, retry: { maxAttempts: 2 } } : s))));
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("waiting-approval");
    const failed = (await engine.trace(run.runId)).find((e) => e.type === "step-failed");
    expect(failed).toMatchObject({ step: "triage", attempt: 1, error: { name: "AiOutputError" }, retryable: true, final: false });
  });

  it("an answer naming another aircraft's event never reaches an approver or an Action", async () => {
    const { tb, engine } = await fixture({ triage: { ...TRIAGE, eventId: "EVT-OTHER-AIRCRAFT" } });
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/proposal.*not in this aircraft's history/);
    expect(await workOrders(tb)).toHaveLength(0);
  });
});

describe("the definition check (ADR-0057)", () => {
  let model: Awaited<ReturnType<typeof describeModel>>;
  const codes = async (w: AnyWorkflow) => {
    model ??= await describeModel((await buildAirforceTestbed({ mockRestLatencyMs: 0 })).registry);
    return validateWorkflow(w, model).map((d) => `${d.code}:${d.step ?? ""}`);
  };
  const without = (name: string) => (steps: AnyWorkflow["steps"]) =>
    steps.filter((s) => s.name !== name).map((s) => ({ ...s, needs: (s.needs ?? []).filter((n) => n !== name) }));

  it("accepts the demo workflow", async () => {
    expect(await codes(groundForRepair as unknown as AnyWorkflow)).toEqual([]);
  });

  it("refuses an Action with side effects fed by an AI step no approval reviewed", async () => {
    expect(await codes(variant("2.0.0", without("leadApproval")))).toEqual(["unreviewed-ai-output:openWorkOrder", "unreviewed-ai-output:startWork"]);
    // An approval that does not depend on the AI step did not review it.
    const blind = variant("2.0.1", (steps) => steps.map((s) => (s.name === "leadApproval" ? { ...s, needs: ["flagged", "aircraft"] } : s)));
    expect(await codes(blind)).toEqual(["unreviewed-ai-output:openWorkOrder", "unreviewed-ai-output:startWork"]);
  });

  it("refuses retrying an Action that is not idempotent, unknown Actions, and reading a later step", async () => {
    const w = variant("2.1.0", (steps) =>
      steps.map((s) => {
        if (s.name === "openWorkOrder") return { ...s, retry: { maxAttempts: 2 } };
        if (s.name === "startWork") return { ...s, action: "DeleteEverything" } as unknown as typeof s;
        if (s.name === "flagged") return { ...s, needs: ["aircraft", "history"] };
        return s;
      })
    );
    expect(await codes(w)).toEqual(["unknown-need:flagged", "retry-not-idempotent:openWorkOrder", "unknown-action:startWork"]);
  });

  it("the engine refuses to register what the check rejects", async () => {
    const { engine } = await fixture();
    expect(() => engine.register(variant("2.0.0", without("leadApproval")))).toThrow(WorkflowDefinitionError);
  });

  it("a step that reads an output it did not declare fails at run time", async () => {
    const { engine } = await fixture();
    engine.register(variant("1.2.0", (steps) => steps.map((s) => (s.name === "flagged" ? { ...s, needs: [] } : s))));
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/does not declare in needs/);
  });
});

describe("retries, compensation and recovery", () => {
  it("retries a retryable failure with backoff, and only that", async () => {
    const { tb, engine, sleeps } = await fixture({ faults: { startWork: [{ attempt: 1, error: new AdapterUnavailableError("maintenance system unreachable") }] } });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("completed");
    expect(run.steps.find((s) => s.name === "startWork")?.attempts).toBe(2);
    expect(sleeps).toEqual([25]);
    expect((await workOrders(tb))[0]?.status).toBe("in-progress");
  });

  it("closes the work order it opened when a later step fails", async () => {
    const { tb, engine } = await fixture({ faults: { startWork: [{ error: new Error("hangar unavailable") }] } });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("failed");
    expect(run.reason).toBe('Step "startWork" failed: Error: hangar unavailable');
    expect(run.steps.find((s) => s.name === "startWork")?.attempts).toBe(1); // not retryable, so tried once despite its retry policy
    expect(run.steps.find((s) => s.name === "openWorkOrder")?.compensation).toBe("completed");
    expect((await workOrders(tb)).map((o) => o.status)).toEqual(["closed"]);
  });

  it("a failed compensation leaves the run for a person to reconcile", async () => {
    const { engine } = await fixture({ faults: { startWork: [{ error: new Error("x") }], "openWorkOrder.compensate": [{ error: new Error("cannot close") }] } });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("needs-reconciliation");
    expect(run.reason).toMatch(/Compensation of step "openWorkOrder" failed: cannot close/);
  });

  it("resumes after a restart from the journal alone", async () => {
    const journal = new InMemoryJournal();
    const first = await fixture({ journal });
    const { runId } = await first.engine.start("airforce.GroundForRepair", START, maintainer);
    // A new process: a new engine over the same journal and the same systems.
    const second = await fixture({ journal, host: first.tb });
    const run = await second.engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("completed");
    expect(second.calls).toHaveLength(0); // the model's answer came from the journal
  });

  it("never repeats a non-idempotent Action whose outcome was lost; repeats a naturally idempotent one", async () => {
    for (const at of ["before-effect", "after-effect"] as const) {
      const journal = new InMemoryJournal();
      const first = await fixture({ journal, faults: { openWorkOrder: [{ crash: at }] } });
      const { runId } = await first.engine.start("airforce.GroundForRepair", START, maintainer);
      await expect(first.engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/Simulated crash/);
      const second = await fixture({ journal, host: first.tb });
      const run = await second.engine.resume(runId);
      expect(run.status).toBe("needs-reconciliation");
      // The engine cannot tell the two crashes apart, so it assumes the worse: one work order at most, never two.
      expect(await workOrders(first.tb)).toHaveLength(at === "after-effect" ? 1 : 0);
    }

    const journal = new InMemoryJournal();
    const first = await fixture({ journal, faults: { startWork: [{ crash: "after-effect", attempt: 1 }] } });
    const { runId } = await first.engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(first.engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/Simulated crash/);
    const second = await fixture({ journal, host: first.tb });
    const [resumed] = await second.engine.resumeAll();
    expect(resumed?.status).toBe("completed");
    expect((await workOrders(first.tb)).map((o) => o.status)).toEqual(["in-progress"]);
  });

  it("acts with the initiator's current roles when the host re-resolves them", async () => {
    let current: Identity = maintainer;
    const { tb, engine } = await fixture({ resolveIdentity: async () => current });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    current = { ...maintainer, roles: [] }; // revoked while the run waited
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    // Suspended before the Action, not failed at it (ADR-0065): nothing was attempted as the revoked maintainer.
    expect(run.status).toBe("suspended");
    expect(run.steps.find((s) => s.name === "openWorkOrder")?.status).toBe("pending");
    expect(await workOrders(tb)).toHaveLength(0);
  });
});

describe("replay (ADR-0057)", () => {
  it("a recorded run replays under its definition, and a changed definition is caught where it diverges", async () => {
    const { engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    await engine.approve(runId, "leadApproval", lead, { approved: true });
    const trace = await engine.trace(runId);
    expect(() => replay(groundForRepair as unknown as AnyWorkflow, runId, trace)).not.toThrow();

    const changed = (name: string, patch: object) => variant("1.0.0", (steps) => steps.map((s) => (s.name === name ? ({ ...s, ...patch }) : s)));
    expect(() => replay(changed("proposal", { run: () => ({ ...TRIAGE, priority: "routine" }) }), runId, trace)).toThrow(/"proposal": it now computes a different output/);
    expect(() => replay(changed("openWorkOrder", { input: () => ({ maintenanceEventId: "EVT-9001", assignedTo: "x" }) }), runId, trace)).toThrow(
      /"openWorkOrder": it would now invoke its Action with a different input/
    );
    expect(() => replay(changed("history", { when: () => false }), runId, trace)).toThrow(/"history": it ran, and would now be skipped/);
    expect(() => replay(variant("1.0.0", (steps) => steps.filter((s) => s.name !== "startWork")), runId, trace)).toThrow(ReplayDivergenceError);
  });

  it("the engine will not resume a run under a definition that diverges from its journal", async () => {
    const journal = new InMemoryJournal();
    const first = await fixture({ journal });
    const { runId } = await first.engine.start("airforce.GroundForRepair", START, maintainer);
    const tb = first.tb;
    const engine = await WorkflowEngine.create({ host: tb, journal, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
    engine.register(variant("1.0.0", (steps) => steps.map((s) => (s.name === "flagged" ? ({ ...s, run: () => false } as typeof s) : s))));
    await expect(engine.resume(runId)).rejects.toBeInstanceOf(ReplayDivergenceError);
    await expect(engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toBeInstanceOf(ReplayDivergenceError);
    expect((await first.engine.status(runId)).status).toBe("waiting-approval");
  });
});
