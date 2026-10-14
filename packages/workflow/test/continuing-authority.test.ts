import { describe, it, expect } from "vitest";
import { AdapterUnavailableError, AuthorizationError, NotFoundError, type Identity, type SemanticRuntime } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed, type TriageProposal } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { InMemoryJournal, WorkflowEngine, scriptedModel, type AnyWorkflow, type WorkflowEngineOptions, type WorkflowJournal } from "../src/index.js";

/**
 * Continuing authority and durable timers (ADR-0065). Each test tries to make
 * a run act on authority it no longer has, or to lose a timer to a restart,
 * and checks that nothing executed that should not have.
 */
const { maintainer, lead, viewer } = demoIdentities;
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const T0 = Date.parse("2026-10-14T12:00:00Z");

/** The demo workflow with a one-minute approval deadline and leads allowed to cancel. */
const withDeadline: AnyWorkflow = {
  ...(groundForRepair as unknown as AnyWorkflow),
  cancelPolicy: "airforce.maintenance-lead",
  steps: (groundForRepair as unknown as AnyWorkflow).steps.map((s) => (s.kind === "approval" ? { ...s, deadline: { afterMs: 60_000 } } : s))
};

interface Clock {
  t: number;
}

async function fixture(opts: Partial<WorkflowEngineOptions> & { clock?: Clock; journal?: WorkflowJournal; tb?: AirforceTestbed } = {}) {
  const tb = opts.tb ?? (await buildAirforceTestbed({ mockRestLatencyMs: 0 }));
  const clock = opts.clock ?? { t: T0 };
  const engine = await WorkflowEngine.create({
    sleep: async () => {},
    now: () => new Date(clock.t),
    ...opts,
    host: opts.host ?? tb,
    model: scriptedModel({ triage: TRIAGE }, "test-model", demoAudiences.enclaveModel)
  });
  engine.register(withDeadline);
  return { tb, engine, clock };
}

async function workOrders(tb: AirforceTestbed) {
  return (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;
}

async function auditOf(tb: AirforceTestbed, action: string) {
  return (await tb.registry.listAuditEvents({ limit: 1000 })).items.filter((e) => e.action === action);
}

describe("a run acts only on authority its initiator still holds (ADR-0065)", () => {
  it("revoked while waiting on an approval: suspended before any Action, resumed only once re-authorized", async () => {
    let current: Identity = maintainer;
    const { tb, engine } = await fixture({ resolveIdentity: async () => current });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    current = { ...maintainer, roles: [] };
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("suspended");
    expect(run.reason).toMatch(/no longer admitted by "airforce.maintainer-only"/);
    expect(await workOrders(tb)).toHaveLength(0);
    expect((await auditOf(tb, "workflow.authority")).map((e) => e.decision)).toEqual(["deny"]);
    // A resume does nothing while it is suspended.
    expect((await engine.resume(runId)).status).toBe("suspended");
    expect(await engine.resumeAll()).toEqual([]);

    // Re-authorizing with the roles still revoked is refused; once restored, the run completes.
    await expect(engine.reauthorize(runId, current)).rejects.toThrow(AuthorizationError);
    current = maintainer;
    expect((await engine.reauthorize(runId, maintainer)).status).toBe("completed");
    expect(await workOrders(tb)).toHaveLength(1);
  });

  it("a subject the directory no longer knows suspends the run; any other resolver error leaves it to be resumed", async () => {
    let fail: Error | undefined = new NotFoundError("no such subject");
    const { tb, engine } = await fixture({ resolveIdentity: async (s) => { if (fail) throw fail; return s; } });
    await expect(engine.start("airforce.GroundForRepair", START, maintainer)).resolves.toMatchObject({ status: "suspended" });
    fail = new Error("directory timeout");
    const second = await fixture({ tb, resolveIdentity: async () => { throw fail; } });
    await expect(second.engine.start("airforce.GroundForRepair", START, maintainer)).rejects.toThrow(/directory timeout/);
    expect(await workOrders(tb)).toHaveLength(0);
  });

  it("only the subject the run acts as may re-authorize it, and a refusal is audited", async () => {
    let current: Identity = { ...maintainer, roles: [] };
    const { tb, engine } = await fixture({ resolveIdentity: async () => current });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    current = maintainer;
    await expect(engine.reauthorize(runId, lead)).rejects.toThrow(/Not authorized: reauthorize/);
    await expect(engine.reauthorize(runId, { ...lead, subjectId: "user-maintainer-2" })).rejects.toThrow(AuthorizationError);
    expect((await auditOf(tb, "workflow.reauthorize")).map((e) => [e.subjectId, e.decision]).sort()).toEqual([
      ["user-lead-1", "deny"],
      ["user-maintainer-2", "deny"]
    ]);
  });

  it("a resolver that answers with another subject cannot hand the run to them", async () => {
    const { tb, engine } = await fixture({ resolveIdentity: async () => lead });
    const run = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect(run).toMatchObject({ status: "suspended" });
    expect(run.reason).toMatch(/different subject/);
    expect(await workOrders(tb)).toHaveLength(0);
  });

  it("without a resolver, a stale identity suspends the run, and the initiator's fresh sign-in resumes it", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const clock = { t: T0 };
    const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({ triage: TRIAGE }, "m", demoAudiences.enclaveModel), now: () => new Date(clock.t), sleep: async () => {}, identityMaxAgeMs: 10 * 60_000 });
    engine.register(groundForRepair); // no deadline
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    clock.t += 30 * 60_000;
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run).toMatchObject({ status: "suspended" });
    expect(run.reason).toMatch(/1800s old/);
    expect(await workOrders(tb)).toHaveLength(0);
    expect((await engine.reauthorize(runId, maintainer)).status).toBe("completed");
  });

  it("expired credentials stop a run, and cannot re-authorize it", async () => {
    const { tb, engine, clock } = await fixture();
    const expiring = { ...maintainer, expiresAt: new Date(T0 + 30_000).toISOString() };
    const { runId } = await engine.start("airforce.GroundForRepair", START, expiring);
    clock.t += 45_000; // past the token, inside the approval deadline
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run).toMatchObject({ status: "suspended" });
    expect(run.reason).toMatch(/expired/);
    await expect(engine.reauthorize(runId, expiring)).rejects.toThrow(AuthorizationError);
    expect((await engine.reauthorize(runId, { ...maintainer, expiresAt: new Date(clock.t + 60_000).toISOString() })).status).toBe("completed");
    expect(await workOrders(tb)).toHaveLength(1);
  });

  it("a policy change between two Actions stops the run before the second; a lead cancels it and the first is undone", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    let revoked = false;
    const runtime = new Proxy(tb.runtime, {
      get(target, prop, receiver) {
        if (prop !== "invokeAction") return Reflect.get(target, prop, receiver) as unknown;
        return async (...args: Parameters<SemanticRuntime["invokeAction"]>) => {
          const out = await target.invokeAction(...args);
          if (args[0] === "CreateMaintenanceWorkOrder") revoked = true; // the maintainer is removed mid-run
          return out;
        };
      }
    });
    const policyEngine = {
      evaluate: async (req: Parameters<AirforceTestbed["policyEngine"]["evaluate"]>[0]) =>
        revoked && req.policyName === "airforce.maintainer-only" && req.subject.subjectId === maintainer.subjectId ? { allow: false, reason: "removed from the squadron" } : tb.policyEngine.evaluate(req)
    };
    const { engine } = await fixture({ tb, host: { runtime, policyEngine, registry: tb.registry } });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("suspended");
    expect(run.steps.filter((s) => s.status === "completed").map((s) => s.name)).toContain("openWorkOrder");
    expect(run.steps.find((s) => s.name === "startWork")?.status).toBe("pending");
    expect((await workOrders(tb)).map((o) => o.status)).toEqual(["open"]);

    await expect(engine.cancel(runId, viewer)).rejects.toThrow(AuthorizationError);
    const cancelled = await engine.cancel(runId, lead, "maintainer reassigned");
    expect(cancelled).toMatchObject({ status: "cancelled", reason: "Cancelled by user-lead-1: maintainer reassigned" });
    expect((await workOrders(tb)).map((o) => o.status)).toEqual(["closed"]);
  });

  it("the initiator may cancel their own run while it waits; nothing ran, so nothing is undone", async () => {
    const { tb, engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    expect((await engine.cancel(runId, maintainer)).status).toBe("cancelled");
    await expect(engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/not waiting/);
    expect(await workOrders(tb)).toHaveLength(0);
  });
});

describe("durable timers (ADR-0065)", () => {
  it("an approval past its deadline expires, even when a new process finds it", async () => {
    const journal = new InMemoryJournal();
    const clock = { t: T0 };
    const first = await fixture({ journal, clock });
    const { runId } = await first.engine.start("airforce.GroundForRepair", START, maintainer);
    expect((await first.engine.status(runId)).timers).toEqual([{ name: "approval:leadApproval", dueAt: new Date(T0 + 60_000).toISOString() }]);
    expect(await first.engine.tick()).toEqual([]); // not due yet

    clock.t += 61_000;
    const restarted = await fixture({ journal, clock, tb: first.tb });
    const [run] = await restarted.engine.tick();
    expect(run).toMatchObject({ status: "rejected", reason: 'Approval "leadApproval" expired with no decision' });
    expect(run!.steps.find((s) => s.name === "leadApproval")?.status).toBe("rejected");
    await expect(restarted.engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/not waiting/);
    expect(await workOrders(first.tb)).toHaveLength(0);
  });

  it("an approval decided after its deadline, before any tick, is refused and the approval expires", async () => {
    const { tb, engine, clock } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    clock.t += 61_000;
    await expect(engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/expired at/);
    expect((await engine.status(runId)).status).toBe("rejected");
    expect(await workOrders(tb)).toHaveLength(0);
  });

  it("a long retry backoff is a durable timer: the run waits, survives a restart, and continues when it is due", async () => {
    const journal = new InMemoryJournal();
    const clock = { t: T0 };
    const faults = { aircraft: [{ attempt: 1, error: new AdapterUnavailableError("fleet system unreachable") }] };
    const first = await fixture({ journal, clock, faults, inlineWaitMs: 0 });
    const started = await first.engine.start("airforce.GroundForRepair", START, maintainer);
    expect(started.status).toBe("waiting-timer");
    expect(started.timers).toEqual([{ name: "retry:aircraft", dueAt: new Date(T0 + 25).toISOString() }]);

    const restarted = await fixture({ journal, clock, tb: first.tb, inlineWaitMs: 0 });
    expect(await restarted.engine.tick()).toEqual([]);
    expect((await restarted.engine.resumeAll()).map((r) => r.status)).toEqual(["waiting-timer"]);
    clock.t += 25;
    const [run] = await restarted.engine.tick();
    expect(run?.status).toBe("waiting-approval");
    expect(run?.steps.find((s) => s.name === "aircraft")).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("two processes ticking the same run at once: one advances it, neither repeats an Action", async () => {
    const journal = new InMemoryJournal();
    const clock = { t: T0 };
    const a = await fixture({ journal, clock });
    const b = await fixture({ journal, clock, tb: a.tb });
    const { runId } = await a.engine.start("airforce.GroundForRepair", START, maintainer);
    await a.engine.approve(runId, "leadApproval", lead, { approved: true });
    // Finished: a concurrent tick and resume find nothing to do.
    await Promise.all([a.engine.tick(), b.engine.tick(), a.engine.resumeAll(), b.engine.resumeAll()]);
    expect((await workOrders(a.tb)).map((o) => o.status)).toEqual(["in-progress"]);

    const second = await a.engine.start("airforce.GroundForRepair", START, maintainer);
    clock.t += 61_000;
    const results = await Promise.allSettled([a.engine.tick(), b.engine.tick()]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await a.engine.status(second.runId)).status).toBe("rejected");
    expect(await workOrders(a.tb)).toHaveLength(1);
  });

  it("a journal shared with another service: sweeps advance only this engine's workflows", async () => {
    const journal = new InMemoryJournal();
    const clock = { t: T0 };
    await journal.append("foreign-run", 0, [{ type: "run-started", workflow: "logistics.Resupply", version: "2.0.0", initiator: maintainer, input: {} }], new Date(T0).toISOString());
    const { engine } = await fixture({ journal, clock });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    clock.t += 61_000;
    expect((await engine.tick()).map((r) => r.runId)).toEqual([runId]);
    expect(await engine.resumeAll()).toEqual([]);
    expect(await engine.approvalsFor(lead)).toEqual([]);
    expect((await journal.read("foreign-run"))).toHaveLength(1);
  });
});
