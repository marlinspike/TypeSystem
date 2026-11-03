import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { verifyAuditLog, type AuditEvent } from "@typesys/core";
import { PostgresAuditLog } from "../src/postgres-audit-log.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
const key = { keyId: "k1", privateKey };

function event(id: string, at: Date, extra: Partial<AuditEvent> = {}): AuditEvent {
  return { id, timestamp: at.toISOString(), subjectId: "u1", action: "read", resource: { typeName: "airforce.Aircraft", objectId: "AF86-0147", propertyPath: "maintenanceStatus" }, decision: "allow", details: { reason: "role", nested: { b: 2, a: [1, "x", null] } }, build: "sha256:abc", ...extra };
}

/** Each test gets a private schema, migrated, so it starts from an empty trail. */
describe.skipIf(!hasDb)("PostgresAuditLog (ADR-0105)", () => {
  const schema = `audit_chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  it("two replicas write two chains into one table, and both verify", async () => {
    const a = new PostgresAuditLog(pool(), { chain: "replica-a", key, everyRows: 5 });
    const b = new PostgresAuditLog(pool(), { chain: "replica-b", key, everyRows: 5 });
    const t = Date.UTC(2026, 10, 1);
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).appendAuditEvent(event(`two-${i}`, new Date(t + i * 1000)))));
    await a.close();
    await b.close();
    const reader = new PostgresAuditLog(pool());
    const v = await verifyAuditLog(reader, keys, { pageSize: 4 });
    expect(v.problems).toEqual([]);
    expect(v.chains.filter((c) => c.chain.startsWith("replica-")).map((c) => [c.chain, c.rows, c.unanchored])).toEqual([
      ["replica-a", 15, 0],
      ["replica-b", 15, 0]
    ]);
    // The listing every caller already uses still reads the rows, newest first.
    const listed = await reader.listAuditEvents({ limit: 3 });
    expect(listed.items).toHaveLength(3);
  });

  it("an UPDATE is refused, and a row edited with the triggers off fails verification", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "edited", key });
    for (let i = 0; i < 3; i++) await log.appendAuditEvent(event(`ed-${i}`, new Date(Date.UTC(2026, 10, 2, 0, 0, i))));
    await log.close();
    const p = pool();
    await expect(p.query(`UPDATE audit_events SET decision = 'deny' WHERE id = 'ed-1'`)).rejects.toThrow(/append-only/);
    // Someone who owns the table can lift the trigger; the chain still tells.
    await p.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`);
    try {
      await p.query(`UPDATE audit_events SET decision = 'deny' WHERE id = 'ed-1'`);
    } finally {
      await p.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`);
    }
    const v = await verifyAuditLog(new PostgresAuditLog(p), keys);
    expect(v.problems.filter((x) => x.chain === "edited").map((x) => [x.kind, x.seq])).toEqual([["altered", 2]]);
  });

  it("a DELETE outside a prune is refused; a row deleted with the trigger off is found", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "deleted", key });
    for (let i = 0; i < 4; i++) await log.appendAuditEvent(event(`del-${i}`, new Date(Date.UTC(2026, 10, 2, 1, 0, i))));
    await log.close();
    const p = pool();
    await expect(p.query(`DELETE FROM audit_events WHERE id = 'del-3'`)).rejects.toThrow(/append-only/);
    await p.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_delete`);
    try {
      await p.query(`DELETE FROM audit_events WHERE id IN ('del-1', 'del-3')`);
    } finally {
      await p.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_delete`);
    }
    const kinds = (await verifyAuditLog(new PostgresAuditLog(p), keys)).problems.filter((x) => x.chain === "deleted").map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["missing", "truncated"]));
  });

  it("even a prune session cannot delete a row no checkpoint covers", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "unanchored" });
    await log.appendAuditEvent(event("un-1", new Date(Date.UTC(2020, 0, 1))));
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL typesys.audit_prune = 'on'");
      await expect(client.query(`DELETE FROM audit_events WHERE id = 'un-1'`)).rejects.toThrow(/append-only/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await log.close();
  });

  it("checkpoints are append-only", async () => {
    const p = pool();
    await expect(p.query(`DELETE FROM audit_checkpoints`)).rejects.toThrow(/append-only/);
    await expect(p.query(`TRUNCATE audit_checkpoints`)).rejects.toThrow(/append-only/);
  });

  it("prunes only behind a checkpoint, and what remains verifies", async () => {
    const log = new PostgresAuditLog(pool(), { chain: "retained", key, everyRows: 3 });
    const old = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 8; i++) await log.appendAuditEvent(event(`ret-${i}`, new Date(old + i * 86_400_000)));
    await log.close();
    // Checkpoints at 3, 6 and 8 (close). Rows 1..5 are before the cutoff; the latest checkpointed row before it is 3, which stays.
    const r = await new PostgresAuditLog(pool()).prune(new Date(old + 4.5 * 86_400_000));
    expect(r.chains.find((c) => c.chain === "retained")).toEqual({ chain: "retained", through: 3, deleted: 2 });
    const remaining = await new PostgresAuditLog(pool()).readChain("retained");
    expect(remaining.map((x) => x.link.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    const v = await verifyAuditLog(new PostgresAuditLog(pool()), keys);
    expect(v.problems.filter((x) => x.chain === "retained")).toEqual([]);
  });

  it("never prunes rows written before chaining", async () => {
    const p = pool();
    await p.query(`INSERT INTO audit_events (id, "timestamp", subject_id, action, resource_type_name, decision) VALUES ('legacy-1', '2020-01-01T00:00:00Z', 's', 'read', 't', 'allow')`);
    await new PostgresAuditLog(p).prune(new Date());
    const { rows } = await p.query(`SELECT id FROM audit_events WHERE id = 'legacy-1'`);
    expect(rows).toHaveLength(1);
    expect((await verifyAuditLog(new PostgresAuditLog(p), keys)).unchained).toBeGreaterThanOrEqual(1);
  });
});
