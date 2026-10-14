import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JournalConflictError, type JournalEvent, type JournalRecord, type WorkflowJournal } from "@typesys/workflow";
import type { Pool, PoolClient } from "pg";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Creates or updates the journal's tables and triggers, running every
 * migration in order. Each is idempotent, and the run is serialized by an
 * advisory lock so replicas may all run it at start.
 */
export async function migrateWorkflowJournal(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('typesys_workflow_journal'))");
    for (const f of files) await client.query(await readFile(path.join(MIGRATIONS, f), "utf8"));
  } finally {
    const unlocked = await client.query("SELECT pg_advisory_unlock(hashtext('typesys_workflow_journal'))").then(
      () => true,
      () => false
    );
    client.release(!unlocked);
  }
}

/**
 * JSONB cannot hold U+0000 or an unpaired UTF-16 surrogate, which an Action's
 * output or a caller's text may. An event whose JSON has either is stored as
 * its JSON text under a key no event has, beside its `type`, so the journal's
 * triggers still recognise what kind of event it is (a run-finished one ends
 * the run whatever its reason holds).
 */
const WRAPPED = "$typesys-json";
const UNSTORABLE = /\\u0000|\\u[dD][89abAB][0-9a-fA-F]{2}/;
const encode = (event: JournalEvent): string => {
  const json = JSON.stringify(event);
  return UNSTORABLE.test(json) ? JSON.stringify({ type: event.type, [WRAPPED]: json }) : json;
};
const decode = (stored: JournalEvent | { [WRAPPED]: string }): JournalEvent =>
  Object.hasOwn(stored, WRAPPED) ? (JSON.parse((stored as { [WRAPPED]: string })[WRAPPED]) as JournalEvent) : (stored as JournalEvent);

/**
 * The durable `WorkflowJournal` (ADR-0066). An append is one transaction:
 * the run's row is locked, its length compared with what the writer read,
 * and the events written only if they match, so of two processes advancing
 * one run exactly one writes (the other gets `JournalConflictError` and
 * re-reads). Starting a run is the same race on inserting its row. Events
 * are JSONB and append-only by trigger. `unfinished()` reads a partial
 * index, so `tick()` and `resumeAll()` do not read finished runs.
 */
export class PostgresWorkflowJournal implements WorkflowJournal {
  constructor(private readonly pool: Pool) {}

  async append(runId: string, expectedLength: number, events: readonly JournalEvent[], at: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actual = await this.lockLength(client, runId, expectedLength, at);
      if (actual !== expectedLength) {
        await client.query("ROLLBACK");
        throw new JournalConflictError(runId, expectedLength, actual);
      }
      let seq = expectedLength;
      for (const event of events) {
        await client.query("INSERT INTO typesys_workflow_events (run_id, seq, at, event) VALUES ($1, $2, $3, $4)", [runId, seq++, at, encode(event)]);
      }
      const finished = events.some((e) => e.type === "run-finished");
      await client.query("UPDATE typesys_workflow_runs SET length = $2, finished = finished OR $3, updated_at = $4 WHERE run_id = $1", [runId, seq, finished, at]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // A unique violation is another writer that got there first.
      if ((err as { code?: string }).code === "23505") throw new JournalConflictError(runId, expectedLength, await this.length(runId));
      throw err;
    } finally {
      client.release();
    }
  }

  /** The run's length, with its row locked; for a new run, the row is created (length 0) if this writer is first. */
  private async lockLength(client: PoolClient, runId: string, expectedLength: number, at: string): Promise<number> {
    if (expectedLength === 0) {
      const inserted = await client.query("INSERT INTO typesys_workflow_runs (run_id, length, updated_at) VALUES ($1, 0, $2) ON CONFLICT (run_id) DO NOTHING RETURNING length", [runId, at]);
      if (inserted.rowCount === 1) return 0;
    }
    const { rows } = await client.query<{ length: number }>("SELECT length FROM typesys_workflow_runs WHERE run_id = $1 FOR UPDATE", [runId]);
    return rows[0]?.length ?? 0;
  }

  private async length(runId: string): Promise<number> {
    const { rows } = await this.pool.query<{ length: number }>("SELECT length FROM typesys_workflow_runs WHERE run_id = $1", [runId]);
    return rows[0]?.length ?? 0;
  }

  async read(runId: string): Promise<JournalRecord[]> {
    const { rows } = await this.pool.query<{ seq: number; at: string; event: JournalEvent }>("SELECT seq, at, event FROM typesys_workflow_events WHERE run_id = $1 ORDER BY seq", [runId]);
    return rows.map((r) => ({ ...decode(r.event), seq: r.seq, at: r.at }));
  }

  async runs(): Promise<string[]> {
    const { rows } = await this.pool.query<{ run_id: string }>("SELECT run_id FROM typesys_workflow_runs ORDER BY run_id");
    return rows.map((r) => r.run_id);
  }

  async unfinished(): Promise<string[]> {
    const { rows } = await this.pool.query<{ run_id: string }>("SELECT run_id FROM typesys_workflow_runs WHERE NOT finished ORDER BY run_id");
    return rows.map((r) => r.run_id);
  }
}
