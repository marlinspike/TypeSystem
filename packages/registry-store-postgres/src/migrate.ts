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
// @typesys/adapter-postgres (or any other package with its own migrations). A
// shared tracking table name would mean one package's applied migration ID
// silently satisfies another's "already applied" check — a real bug this
// exact scenario hit during development. Each package tracks its own.
const TRACKING_TABLE = "registry_postgres_schema_migrations";

/**
 * A ~50-line tracked-SQL-files runner, not a migration framework (see
 * ADR-0015, "Alternatives Considered"). Ordered `.sql` files, each applied
 * exactly once inside its own transaction, tracked in a table scoped to
 * this package. Deliberately never called automatically by
 * `PostgresRegistryStore` — invoke this explicitly (`npm run migrate` in
 * this package, or a CI/deploy step) so schema changes are never racing
 * concurrent application boots.
 */
export async function runMigrations(pool: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await pool.connect();
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
    client.release();
  }
}
