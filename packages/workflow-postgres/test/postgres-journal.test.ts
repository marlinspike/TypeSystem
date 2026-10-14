import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { WorkflowEngine, scriptedModel, workflowJournalContract, type AnyWorkflow } from "@typesys/workflow";
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "../src/index.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const { maintainer, lead } = demoIdentities;
const START = { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" };
const TRIAGE = { eventId: "EVT-9002", priority: "urgent", rationale: "Unscheduled avionics fault." };

describe.skipIf(!hasDb)("PostgresWorkflowJournal (ADR-0066)", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
    await Promise.all([migrateWorkflowJournal(pool), migrateWorkflowJournal(pool)]); // replicas migrating at once
  });
  afterAll(async () => pool?.end());

  workflowJournalContract("PostgresWorkflowJournal", async () => new PostgresWorkflowJournal(pool), { describe, it, expect });

  it("refuses to change or delete a recorded event", async () => {
    const j = new PostgresWorkflowJournal(pool);
    const run = `immutable-${Date.now()}`;
    await j.append(run, 0, [{ type: "run-started", workflow: "t.W", version: "1", initiator: maintainer, input: {} }], new Date().toISOString());
    await expect(pool.query("UPDATE typesys_workflow_events SET event = '{}' WHERE run_id = $1", [run])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM typesys_workflow_events WHERE run_id = $1", [run])).rejects.toThrow(/append-only/);
  });

  async function engineOver(tb: AirforceTestbed, clock: { t: number }, faults = {}) {
    const engine = await WorkflowEngine.create({
      host: tb,
      journal: new PostgresWorkflowJournal(pool),
      model: scriptedModel({ triage: TRIAGE }, "m", demoAudiences.enclaveModel),
      now: () => new Date(clock.t),
      sleep: async () => {},
      faults
    });
    const w = groundForRepair as unknown as AnyWorkflow;
    engine.register({ ...w, steps: w.steps.map((s) => (s.kind === "approval" ? { ...s, deadline: { afterMs: 60_000 } } : s)) });
    return engine;
  }
  const workOrders = async (tb: AirforceTestbed) => (await createClient<AirforceModel>(runtimeTransport(tb.runtime, lead)).from("airforce.WorkOrder").page()).items;

  it("a run survives the process: a crash after an Action, then two new processes recover concurrently, and the Action is not repeated", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const clock = { t: Date.now() };
    const crashing = await engineOver(tb, clock, { openWorkOrder: [{ attempt: 1, crash: "after-effect" }] });
    const { runId } = await crashing.start("airforce.GroundForRepair", START, maintainer);
    await expect(crashing.approve(runId, "leadApproval", lead, { approved: true })).rejects.toThrow(/Simulated crash/);
    // The work order was opened, but its outcome never recorded: CreateMaintenanceWorkOrder is not idempotent.
    expect(await workOrders(tb)).toHaveLength(1);

    const [a, b] = [await engineOver(tb, clock), await engineOver(tb, clock)];
    const settled = await Promise.allSettled([a.resume(runId), b.resume(runId)]);
    expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
    const run = await a.status(runId);
    expect(run.status).toBe("needs-reconciliation");
    expect(await workOrders(tb)).toHaveLength(1);
    expect((await a.trace(runId)).filter((e) => e.type === "step-started" && e.step === "openWorkOrder")).toHaveLength(1);
  });

  it("an approval deadline set by one process is expired by another after a restart", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const clock = { t: Date.now() };
    const { runId } = await (await engineOver(tb, clock)).start("airforce.GroundForRepair", START, maintainer);
    clock.t += 61_000;
    const ticks = await Promise.all([(await engineOver(tb, clock)).tick(), (await engineOver(tb, clock)).tick()]);
    expect(ticks.flat().some((v) => v.runId === runId)).toBe(true);
    expect((await (await engineOver(tb, clock)).status(runId))).toMatchObject({ status: "rejected" });
    expect(((await (await engineOver(tb, clock)).status(runId))).reason).toMatch(/expired/);
    expect(await new PostgresWorkflowJournal(pool).unfinished()).not.toContain(runId);
  });
});
