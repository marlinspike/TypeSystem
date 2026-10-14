import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { canonical } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { InMemoryJournal, JournalConflictError, WorkflowEngine, scriptedModel, type AnyWorkflow, type JournalEvent } from "@typesys/workflow";
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "../src/index.js";

/**
 * Adversarial review of ADR-0066 against real Postgres. Runs in a private
 * schema (search_path) so destructive probes cannot touch other suites' data.
 */
const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const { maintainer, lead } = demoIdentities;
const SCHEMA = `adv_m2_${process.pid}_${Date.now()}`;
const AT = "2026-10-14T12:00:00.000Z";
const started = (input: unknown = {}): JournalEvent => ({ type: "run-started", workflow: "t.W", version: "1.0.0", initiator: maintainer, input });

describe.skipIf(!hasDb)("ADV: PostgresWorkflowJournal", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 30, options: `-c search_path=${SCHEMA}` });
    await migrateWorkflowJournal(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it("TRUNCATE of the events table is refused like UPDATE and DELETE (append-only)", async () => {
    const j = new PostgresWorkflowJournal(pool);
    await j.append("trunc-run", 0, [started()], AT);
    const truncated = await pool.query("TRUNCATE typesys_workflow_events").then(
      () => "truncated",
      (e: Error) => e.message
    );
    const left = (await j.read("trunc-run")).length;
    // Cleanup so later tests' sweeps don't hit an event-less run (the runs table has no protection either).
    await pool.query("DELETE FROM typesys_workflow_runs WHERE run_id = 'trunc-run'");
    expect({ truncated, left }).toEqual({ truncated: expect.stringMatching(/append-only/), left: 1 });
  });

  it("the runs row cannot be marked finished behind the journal's back (a pending deadline would never fire)", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const clock = { t: Date.parse(AT) };
    const engine = await WorkflowEngine.create({
      host: tb,
      journal: new PostgresWorkflowJournal(pool),
      model: scriptedModel({ triage: { eventId: "EVT-9002", priority: "urgent", rationale: "r" } }, "m", demoAudiences.enclaveModel),
      now: () => new Date(clock.t),
      sleep: async () => {}
    });
    const w = groundForRepair as unknown as AnyWorkflow;
    engine.register({ ...w, steps: w.steps.map((s) => (s.kind === "approval" ? { ...s, deadline: { afterMs: 60_000 } } : s)) });
    const { runId } = await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" }, maintainer);
    const tampered = await pool.query("UPDATE typesys_workflow_runs SET finished = TRUE WHERE run_id = $1", [runId]).then(
      () => "updated",
      (e: Error) => e.message
    );
    clock.t += 61_000;
    await engine.tick();
    expect({ tampered, status: (await engine.status(runId)).status }).toEqual({ tampered: expect.not.stringMatching(/^updated$/), status: "rejected" });
    void lead;
  });

  it("an event holding a NUL character round-trips as it does in the in-memory journal (contract parity)", async () => {
    const value = { note: "before\u0000after" };
    const mem = new InMemoryJournal();
    await mem.append("nul", 0, [started(value)], AT);
    expect((await mem.read("nul"))[0]).toMatchObject({ input: value });
    const j = new PostgresWorkflowJournal(pool);
    const result = await j.append("nul-run", 0, [started(value)], AT).then(
      async () => (await j.read("nul-run"))[0],
      (e: Error) => `${e.name}: ${e.message}`
    );
    expect(result).toMatchObject({ input: value });
  });

  // ---- attacks expected to hold ----

  it("HELD: 40 writers on two pools at one length: exactly one wins, all others get JournalConflictError", async () => {
    const pool2 = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 30, options: `-c search_path=${SCHEMA}` });
    try {
      const [a, b] = [new PostgresWorkflowJournal(pool), new PostgresWorkflowJournal(pool2)];
      await a.append("race", 0, [started()], AT);
      const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).append("race", 1, [{ type: "step-skipped", step: `s${i}` }], AT)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.every((r) => r.status === "fulfilled" || r.reason instanceof JournalConflictError)).toBe(true);
      expect(await a.read("race")).toHaveLength(2);
      const starts = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).append("race-start", 0, [started({ i })], AT)));
      expect(starts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally {
      await pool2.end();
    }
  });

  it("HELD: run ids are parameters (no SQL injection)", async () => {
    const j = new PostgresWorkflowJournal(pool);
    const evil = "x'); DROP TABLE typesys_workflow_events; --";
    await j.append(evil, 0, [started()], AT);
    expect(await j.read(evil)).toHaveLength(1);
    expect(await j.runs()).toContain(evil);
  });

  it("HELD: JSONB round-trip keeps canonical() equal for -0, large/small numbers, key order, undefined members, Dates", async () => {
    const value = { b: -0, a: 2 ** 53, c: 1e21, d: 1e-7, e: 0.1 + 0.2, u: undefined, arr: [undefined, 1], z: { y: 1, x: 2 }, when: new Date(AT) };
    const j = new PostgresWorkflowJournal(pool);
    await j.append("json", 0, [started(value)], AT);
    const back = (await j.read("json"))[0] as { input: unknown };
    expect(canonical(back.input)).toBe(canonical(value));
  });
});
