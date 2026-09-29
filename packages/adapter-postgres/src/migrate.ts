import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

// Package-scoped, deliberately not the plain name "schema_migrations": a real
// deployment may run this package's migrations against the same database as
// @typesys/registry-store-postgres (or any other package with its own
// migrations). A shared tracking table name would mean one package's applied
// migration ID silently satisfies another's "already applied" check — a real
// bug this exact scenario hit during development. Each package tracks its own.
const TRACKING_TABLE = "adapter_postgres_schema_migrations";

/** Same tracked-SQL-files runner as @typesys/registry-store-postgres — see ADR-0015 for why this isn't a framework. */
export async function runMigrations(pool: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
  // Serializes concurrent runs (e.g. one migrate step per replica during a rolling deploy): without
  // it, two runs can both read "nothing applied" and race the same migration. Session-level, keyed
  // by this package's tracking table, and taken before the applied set is read, so a run that
  // waited sees what the winner applied.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [TRACKING_TABLE]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${TRACKING_TABLE}`);
    const appliedIds = new Set(rows.map((r) => r.id));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of files) {
      if (appliedIds.has(file)) {
        alreadyApplied.push(file);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${TRACKING_TABLE} (id) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration "${file}" failed and was rolled back: ${detail}`, { cause: err });
      }
    }

    return { applied, alreadyApplied };
  } finally {
    const unlocked = await client.query("SELECT pg_advisory_unlock(hashtext($1))", [TRACKING_TABLE]).then(
      () => true,
      () => false
    );
    // A connection that may still hold the lock must not go back to the pool; destroying it releases the lock.
    client.release(!unlocked);
  }
}
