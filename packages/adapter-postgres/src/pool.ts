import { Pool, type PoolConfig } from "pg";

/** Same rationale as @typesys/registry-store-postgres's pool.ts: `pg` already reads the standard PG-prefixed env vars, plus `DATABASE_URL` wired in explicitly below. */
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
