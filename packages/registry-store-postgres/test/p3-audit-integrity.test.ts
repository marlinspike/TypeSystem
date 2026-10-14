import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

/**
 * 3.0 pressure test. ADR-0015 says no "application bug, compromised credential short of superuser" can quietly
 * delete an audit row, and the README says update and delete of `audit_events` are blocked by a trigger. The
 * triggers are row-level BEFORE UPDATE / BEFORE DELETE, so TRUNCATE, run with the same credential the
 * runtime uses (it owns the table), empties the log. The workflow journal got a BEFORE TRUNCATE trigger for
 * exactly this in the M2 review (L1, ADR-0066); `audit_events` did not.
 */
describe.skipIf(!hasDb)("P3-A1: audit_events is append-only against TRUNCATE", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("P3-A1: TRUNCATE audit_events is refused for the runtime's own credential", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO audit_events (id, subject_id, action, resource_type_name, decision) VALUES ('p3-a1', 's', 'read', 't', 'allow')`
      );
      // Inside a transaction that is always rolled back, so a passing TRUNCATE never wipes a shared database.
      const outcome = await client.query("TRUNCATE audit_events").then(
        () => "truncated",
        (e: Error) => e.message
      );
      expect(outcome).toMatch(/append-only/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
