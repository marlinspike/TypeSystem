import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { InMemoryAuditLog, verifyAuditLog, type AuditEvent } from "@typesys/core";
import { PostgresAuditLog } from "../src/postgres-audit-log.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const key = { keyId: "k1", privateKey };

const ev = (id: string, extra: Record<string, unknown> = {}): AuditEvent =>
  ({ id, timestamp: new Date(Date.UTC(2026, 10, 1)).toISOString(), subjectId: "u1", action: "read", resource: { typeName: "T" }, decision: "deny", ...extra });

describe.skipIf(!hasDb)("P8 Postgres audit round trip", () => {
  const schema = `p8_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pools: Pool[] = [];
  let admin: Pool;
  const pool = () => {
    const p = createPool({ max: 4, options: `-c search_path=${schema}` });
    pools.push(p);
    return p;
  };
  beforeAll(async () => {
    admin = createPool({ max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await runMigrations(pool());
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("P8-M4: a null reason / details / objectId (e.g. a code rule denying with reason: null) is a false 'altered' after a round trip", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "nulls", key });
    await log.appendAuditEvent(ev("n1", { reason: null }));
    await log.appendAuditEvent(ev("n2", { details: null }));
    await log.appendAuditEvent(ev("n3", { resource: { typeName: "T", objectId: null } }));
    await log.close();
    // In memory the same rows verify:
    const mem = new InMemoryAuditLog({ chain: "nulls", key });
    for (const e of [ev("n1", { reason: null }), ev("n2", { details: null }), ev("n3", { resource: { typeName: "T", objectId: null } })]) await mem.appendAuditEvent(e);
    await mem.close();
    expect((await verifyAuditLog(mem, keys)).problems).toEqual([]);
    const v = await verifyAuditLog(new PostgresAuditLog(pool()), keys);
    expect(v.problems.map((p) => `${p.kind}@${p.seq}`)).toEqual([]);
  });

  it("P8-L1: a details key holding U+0000 (normalization rewrites only values) makes that row unwritable", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "nulkey", key });
    const r = await log.appendAuditEvent(ev("k1", { details: { ["a\u0000b"]: 1 } })).then(
      () => "written",
      (e: Error) => `rejected: ${e.message}`
    );
    await log.close();
    expect(r).toBe("written");
  });
});
