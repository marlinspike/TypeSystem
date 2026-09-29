import { Pool, type PoolConfig } from "pg";

/** Same rationale as @typesys/registry-store-postgres's pool.ts: `pg` already reads the standard PG-prefixed env vars, plus `DATABASE_URL` wired in explicitly below. */
export function createPool(config: PoolConfig = {}): Pool {
  const connectionString = config.connectionString ?? process.env.DATABASE_URL;
  const statementTimeoutMs = Number(process.env.PG_STATEMENT_TIMEOUT_MS);
  return new Pool({
    // Default aligned with SemanticRuntime's DEFAULT_MAX_CONCURRENCY (20 — ADR-0019/0026): one request
    // fanning out to its full concurrency budget must not self-starve a smaller pool and hit the
    // connectionTimeoutMillis below. Size this up further for the number of concurrent requests one
    // process serves; maxConcurrency bounds one request, this bounds the whole process.
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Native backend deadline (ADR-0026): the database kills a query that runs longer than this,
    // rather than leaving it running after the runtime's own deadline already abandoned it. Opt-in
    // via env; unset means no DB-side limit, preserving prior behavior.
    ...(Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
    ...(connectionString ? { connectionString } : {}),
    ...config
  });
}
