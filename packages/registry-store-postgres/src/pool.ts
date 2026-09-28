import { Pool, type PoolConfig } from "pg";

/**
 * Connection configuration is `pg`'s own — passing no explicit `host`
 * (or `connectionString`) already makes `pg` read the standard `PGHOST`/
 * `PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE` env vars, SSL
 * included. Reinventing that parsing would be pure risk for no benefit
 * (see ADR-0015). `DATABASE_URL` is the one convention `pg` itself does
 * *not* read automatically (it's an ecosystem convention, not a `pg`
 * feature), so it's the one thing wired here explicitly. Only pool sizing
 * gets project-specific defaults, and even those are overridable.
 */
export function createPool(config: PoolConfig = {}): Pool {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  return new Pool({
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(connectionString ? { connectionString } : {}),
    ...config
  });
}
