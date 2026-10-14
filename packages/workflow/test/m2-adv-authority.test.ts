import { describe, it, expect } from "vitest";
import { AdapterUnavailableError, InvalidInputError, type Identity, type SemanticRuntime } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed, type TriageProposal } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { InMemoryJournal, WorkflowEngine, scriptedModel, type AnyWorkflow, type WorkflowEngineOptions, type WorkflowJournal } from "../src/index.js";

/**
 * Adversarial review of ADR-0065 / ADR-0066 (continuing authority, durable timers).
 * Every test asserts the SECURE behavior; a failing test is a confirmed defect.
 */
const { maintainer, lead } = demoIdentities;
const TRIAGE: TriageProposal = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const T0 = Date.parse("2026-10-14T12:00:00Z");

const base = groundForRepair as unknown as AnyWorkflow;
const withDeadline = (afterMs = 60_000): AnyWorkflow => ({
  ...base,
  cancelPolicy: "airforce.maintenance-lead",
  steps: base.steps.map((s) => (s.kind === "approval" ? { ...s, deadline: { afterMs } } : s))
});

async function fixture(opts: Partial<WorkflowEngineOptions> & { clock?: { t: number }; journal?: WorkflowJournal; tb?: AirforceTestbed; workflow?: AnyWorkflow } = {}) {
  const tb = opts.tb ?? (await buildAirforceTestbed({ mockRestLatencyMs: 0 }));
  const clock = opts.clock ?? { t: T0 };
  const engine = await WorkflowEngine.create({
    sleep: async () => {},
    now: () => new Date(clock.t),
    ...opts,
    host: opts.host ?? tb,
    model: scriptedModel({ triage: TRIAGE }, "test-model", demoAudiences.enclaveModel)
  });
  engine.register(opts.workflow ?? withDeadline());
  return { tb, engine, clock };
}

async function workOrders(tb: AirforceTestbed) {
  return (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;
}

function proxiedRuntime(tb: AirforceTestbed, hook: (name: string, input: unknown, call: () => Promise<unknown>) => Promise<unknown>): SemanticRuntime {
  return new Proxy(tb.runtime, {
    get(target, prop, receiver) {
      if (prop !== "invokeAction") return Reflect.get(target, prop, receiver) as unknown;
      return async (...args: Parameters<SemanticRuntime["invokeAction"]>) => hook(args[0], args[1], () => target.invokeAction(...args));
    }
  });
}

describe("ADV: cancel vs. an Action whose outcome is not recorded", () => {
  it("cancel after a crash mid-Action must not report 'cancelled' with the non-idempotent Action's effect left in place", async () => {
    const journal = new InMemoryJournal();
    const crashing = await fixture({ journal, faults: { openWorkOrder: [{ attempt: 1, crash: "after-effect" }] } });
    const { runId } = await crashing.engine.start("airforce.GroundForRepair", START, maintainer);
    await expect(crashing.engine.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/Simulated crash/);
    expect(await workOrders(crashing.tb)).toHaveLength(1); // the Action happened

    const restarted = await fixture({ journal, tb: crashing.tb });
    const run = await restarted.engine.cancel(runId, lead, "abort");
    const orders = await workOrders(crashing.tb);
    // Secure: either the in-flight effect is flagged for a person, or it was undone.
    expect({ status: run.status, open: orders.filter((o) => o.status !== "closed").length }).toEqual({ status: "needs-reconciliation", open: 1 });
  });

  it("cancel racing a process that is mid-Action: the Action's effect must not be orphaned under a 'cancelled' run", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inAction = new Promise<void>((r) => (entered = r));
    const runtime = proxiedRuntime(tb, async (name, _input, call) => {
      if (name === "CreateMaintenanceWorkOrder") {
        entered();
        await gate;
      }
      return call();
    });
    const { engine } = await fixture({ tb, host: { runtime, policyEngine: tb.policyEngine, registry: tb.registry } });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const approving = engine.approve(runId, "leadApproval", lead, { approved: true });
    await inAction; // process A is inside CreateMaintenanceWorkOrder
    const cancelled = await engine.cancel(runId, lead, "abort"); // process B
    release();
    await approving.catch(() => undefined);
    const orders = await workOrders(tb);
    const final = await engine.status(runId);
    const openOrders = orders.filter((o) => o.status !== "closed").length;
    console.log("race ->", { cancelStatus: cancelled.status, final: final.status, orders: orders.map((o) => o.status), approve: await approving.then((r) => r.status, (e: Error) => e.name) });
    // Secure: a run that ends "cancelled" has nothing left in effect.
    expect({ cancelStatus: cancelled.status, final: final.status, openOrders }).not.toMatchObject({ final: "cancelled", openOrders: 1 });
  });
});

describe("ADV: authority re-checked before every effectful attempt", () => {
  it("an in-process retry of an Action after its backoff must not run on credentials that expired during the backoff", async () => {
    const clock = { t: T0 };
    const expiring: Identity = { ...maintainer, expiresAt: new Date(T0 + 30_000).toISOString() };
    const { tb, engine } = await fixture({
      clock,
      faults: { startWork: [{ attempt: 1, error: new AdapterUnavailableError("work-order system unreachable") }] },
      sleep: async () => {
        clock.t += 60_000; // the backoff outlasts the token
      }
    });
    const { runId } = await engine.start("airforce.GroundForRepair", START, expiring);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    const startWorkAttempts = (await engine.trace(runId)).filter((e) => e.type === "step-started" && e.step === "startWork").length;
    expect({ status: run.status, startWorkAttempts, orders: (await workOrders(tb)).map((o) => o.status) }).toEqual({
      status: "suspended",
      startWorkAttempts: 1,
      orders: ["open"]
    });
  });
});

describe("ADV: a suspended run must be endable by cancellation (ADR-0065)", () => {
  it("credentials expiring during compensation leave a run nobody but the (gone) initiator can finish undoing", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const clock = { t: T0 };
    const runtime = proxiedRuntime(tb, async (name, input, call) => {
      if (name === "UpdateWorkOrderStatus" && (input as { status?: string }).status === "in-progress") {
        clock.t += 60_000; // the initiator's token lapses while the step is out
        throw new InvalidInputError("work order cannot start");
      }
      return call();
    });
    const { engine } = await fixture({ tb, clock, host: { runtime, policyEngine: tb.policyEngine, registry: tb.registry } });
    const expiring: Identity = { ...maintainer, expiresAt: new Date(T0 + 30_000).toISOString() };
    const { runId } = await engine.start("airforce.GroundForRepair", START, expiring);
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("suspended");
    expect((await workOrders(tb)).map((o) => o.status)).toEqual(["open"]);
    // The workflow has a cancelPolicy admitting leads: a lead should be able to carry the undo.
    const cancelled = await engine.cancel(runId, lead, "initiator left; undo it").catch((e: Error) => e);
    expect(cancelled instanceof Error ? cancelled.message : cancelled.status).toBe("cancelled");
    expect((await workOrders(tb)).map((o) => o.status)).toEqual(["closed"]);
  });
});

describe("ADV: one run must not stop a sweep for every other run", () => {
  it("a transient resolver error for one initiator stops tick() from expiring another run's approval", async () => {
    const clock = { t: T0 };
    let broken = false;
    const { engine } = await fixture({
      clock,
      resolveIdentity: async (s) => {
        if (broken && s.subjectId === lead.subjectId) throw new Error("directory timeout");
        return s;
      }
    });
    const first = await engine.start("airforce.GroundForRepair", START, lead); // a lead is also a maintainer
    const second = await engine.start("airforce.GroundForRepair", START, maintainer);
    broken = true;
    clock.t += 61_000;
    const ticked = await engine.tick().catch((e: Error) => e);
    console.log("tick ->", ticked instanceof Error ? `${ticked.name}: ${ticked.message}` : ticked.map((r) => r.status), "; first:", (await engine.status(first.runId)).status);
    // Secure: the other initiator's expired approval is expired (and compensated) regardless.
    expect((await engine.status(second.runId)).status).toBe("rejected");
  });
});

describe("ADV: approval deadlines are validated", () => {
  for (const afterMs of [Number.NaN, Number.POSITIVE_INFINITY, -60_000]) {
    it(`register refuses deadline.afterMs = ${afterMs}`, async () => {
      const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
      const engine = await WorkflowEngine.create({ host: tb, model: scriptedModel({ triage: TRIAGE }, "m", demoAudiences.enclaveModel) });
      expect(() => engine.register(withDeadline(afterMs))).toThrow();
    });
  }

  it("a non-finite deadline journals a run that then poisons resumeAll for every run", async () => {
    const journal = new InMemoryJournal();
    const { engine } = await fixture({ journal, workflow: withDeadline(Number.POSITIVE_INFINITY) });
    const started = await engine.start("airforce.GroundForRepair", START, maintainer).catch((e: Error) => e);
    console.log("start ->", started instanceof Error ? `${started.name}: ${started.message}` : started.status, "; journaled runs:", (await journal.runs()).length);
    // Secure: the sweep is not broken by a run its own definition cannot advance.
    await expect(engine.resumeAll()).resolves.toBeDefined();
  });
});

describe("ADV: audit evidence of cancellation", () => {
  it("an expired canceller's refused cancel is not audited as allowed", async () => {
    const { tb, engine } = await fixture();
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    const expiredLead: Identity = { ...lead, expiresAt: new Date(T0 - 1).toISOString() };
    await expect(engine.cancel(runId, expiredLead, "x")).rejects.toThrow(/Not authorized/);
    const audits = (await tb.registry.listAuditEvents({ limit: 1000 })).items.filter((e) => e.action === "workflow.cancel");
    expect(audits.map((e) => e.decision)).toEqual(["deny"]);
  });
});

describe("ADV: identityMaxAgeMs", () => {
  it("a NaN identityMaxAgeMs must not disable the age limit", async () => {
    const clock = { t: T0 };
    const { engine } = await fixture({ clock, identityMaxAgeMs: Number.NaN, workflow: withDeadline(10 * 24 * 3600_000) });
    const { runId } = await engine.start("airforce.GroundForRepair", START, maintainer);
    clock.t += 7 * 24 * 3600_000; // a week later
    const run = await engine.approve(runId, "leadApproval", lead, { approved: true });
    expect(run.status).toBe("suspended");
  });
});
