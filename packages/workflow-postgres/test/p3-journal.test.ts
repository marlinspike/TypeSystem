import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildAirforceTestbed, demoAudiences, demoIdentities, groundForRepair } from "@typesys/domain-airforce";
import { InMemoryJournal, WorkflowEngine, scriptedModel, type JournalEvent, type WorkflowJournal } from "@typesys/workflow";
import { PostgresWorkflowJournal, migrateWorkflowJournal } from "../src/index.js";

/**
 * Pressure test 3 of ADR-0066 against real Postgres, in a private schema.
 * The review's fixes for L2 (the runs row follows the events) and L3 (an
 * event with U+0000 is stored as JSON text under a wrapper key) interact:
 * the runs trigger recognizes a run-finished event by `event->>'type'`,
 * which a wrapped event does not have.
 */
const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const { maintainer } = demoIdentities;
const SCHEMA = `p3_journal_${process.pid}_${Date.now()}`;
const AT = "2026-10-14T12:00:00.000Z";

async function engineOn(journal: WorkflowJournal) {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const engine = await WorkflowEngine.create({
    host: tb,
    journal,
    model: scriptedModel({ triage: { eventId: "EVT-9001", priority: "urgent", rationale: "r" } }, "enclave", demoAudiences.enclaveModel),
    sleep: async () => {}
  });
  engine.register(groundForRepair);
  return engine;
}

async function cancelWith(journal: WorkflowJournal, reason: string): Promise<{ cancel: string; status: string; unfinished: boolean }> {
  const engine = await engineOn(journal);
  const { runId, status } = await engine.start("airforce.GroundForRepair", { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" }, maintainer);
  expect(status).toBe("waiting-approval");
  const cancel = await engine.cancel(runId, maintainer, reason).then(
    (v) => v.status,
    (e: Error) => `${e.name}: ${e.message}`
  );
  const unfinished = (await (journal.unfinished?.() ?? journal.runs())).includes(runId);
  return { cancel, status: (await engine.status(runId)).status, unfinished };
}

describe.skipIf(!hasDb)("p3: PostgresWorkflowJournal", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, options: `-c search_path=${SCHEMA}` });
    await migrateWorkflowJournal(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it("held: the in-memory journal finishes a run cancelled with a NUL in its reason", async () => {
    expect(await cancelWith(new InMemoryJournal(), "abort\u0000now")).toEqual({ cancel: "cancelled", status: "cancelled", unfinished: false });
  });

  it("P3-J1: a run whose run-finished event holds a NUL (here from the cancel reason a caller typed) can still finish on Postgres", async () => {
    // Observed: the cancel throws "typesys_workflow_runs: a run is finished only by a run-finished event" and the
    // run stays compensating and unfinished, so every later resumeAll() throws for it.
    expect(await cancelWith(new PostgresWorkflowJournal(pool), "abort\u0000now")).toEqual({ cancel: "cancelled", status: "cancelled", unfinished: false });
  });

  it("P3-J1b: the same for text that merely spells the escape (a backslash, then u0000), which holds no NUL at all", async () => {
    expect(await cancelWith(new PostgresWorkflowJournal(pool), "see C:\\u0000\\logs")).toEqual({ cancel: "cancelled", status: "cancelled", unfinished: false });
  });

  it("P3-J2: an event holding an unpaired UTF-16 surrogate round-trips as it does in the in-memory journal (contract parity, as L3)", async () => {
    // A JavaScript string can hold one (an Action's output cut mid-character, a run input parsed from JSON "\ud800");
    // JSONB refuses it, so the step-completed append after the Action's effect fails.
    const value = { note: "cut\ud800here" };
    const started: JournalEvent = { type: "run-started", workflow: "t.W", version: "1.0.0", initiator: maintainer, input: value };
    const mem = new InMemoryJournal();
    await mem.append("s", 0, [started], AT);
    expect((await mem.read("s"))[0]).toMatchObject({ input: value });
    const j = new PostgresWorkflowJournal(pool);
    const result = await j.append("surrogate-run", 0, [started], AT).then(
      async () => (await j.read("surrogate-run"))[0],
      (e: Error) => `${e.name}: ${e.message}`
    );
    expect(result).toMatchObject({ input: value });
  });
});
