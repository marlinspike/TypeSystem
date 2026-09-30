import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { DecryptionError, EncryptingAdapter, LocalKeyProvider, type EncryptionConfig } from "../src/index.js";

/**
 * The same guarantees against a real PostgreSQL row (ADR-0033): what the
 * database stores — and so every backup and replica of it — is ciphertext.
 * Skipped without `DATABASE_URL`, like every Postgres-backed suite; the
 * in-memory suite proves the same properties without one.
 */
const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const CONFIG: EncryptionConfig = { fields: { "fleet.Pilot": { callsign: { mode: "deterministic" }, homeAddress: {} } }, actions: {} };
const keys = new LocalKeyProvider({ keys: { k1: Buffer.alloc(32, 0x5a).toString("base64") }, active: "k1" });

describe.skipIf(!hasDb)("EncryptingAdapter over PostgresRepositoryAdapter", () => {
  let pool: Pool;
  let put: (typeName: string, objectId: string, values: Record<string, unknown>) => Promise<void>;
  let adapter: EncryptingAdapter;

  beforeAll(async () => {
    // Imported here, not at the top, so the suite costs nothing (and needs no Postgres build) when skipped.
    const pg = await import("@typesys/adapter-postgres");
    pool = pg.createPool();
    await pg.runMigrations(pool);
    const inner = new pg.PostgresRepositoryAdapter(pool, "fleet-pg");
    put = (typeName, objectId, values) => inner.put(typeName, objectId, values);
    adapter = new EncryptingAdapter(inner, keys, CONFIG);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM objects WHERE type_name = 'fleet.Pilot'`);
    await put("fleet.Pilot", "p1", await adapter.seal("fleet.Pilot", "p1", { id: "p1", callsign: "MAVERICK", homeAddress: "12 Runway Rd" }));
    await put("fleet.Pilot", "p2", await adapter.seal("fleet.Pilot", "p2", { id: "p2", callsign: "ICEMAN", homeAddress: "34 Hangar Ln" }));
  });

  it("the row in the database holds no plaintext", async () => {
    const { rows } = await pool.query<{ values: unknown }>(`SELECT values FROM objects WHERE type_name = 'fleet.Pilot'`);
    const dump = JSON.stringify(rows);
    for (const plaintext of ["MAVERICK", "ICEMAN", "Runway", "Hangar"]) expect(dump).not.toContain(plaintext);
  });

  it("reads decrypt, and equality finds the row through its blind index", async () => {
    expect((await adapter.resolveProperties("fleet.Pilot", "p1", [])).values).toEqual({ id: "p1", callsign: "MAVERICK", homeAddress: "12 Runway Rd" });
    const found = await adapter.queryByType("fleet.Pilot", { property: "callsign", operator: "eq", value: "ICEMAN" });
    expect(found.items.map((i) => i.objectId)).toEqual(["p2"]);
  });

  it("a ciphertext moved between rows in the database fails closed (ADR-0035)", async () => {
    await pool.query(
      `UPDATE objects SET values = jsonb_set(values, '{homeAddress}', (SELECT values->'homeAddress' FROM objects WHERE object_id = 'p1')) WHERE object_id = 'p2'`
    );
    await expect(adapter.resolveProperties("fleet.Pilot", "p2", [])).rejects.toThrow(/homeAddress of "p2" failed authentication/);
  });

  it("a ciphertext tampered with in the database fails closed", async () => {
    await pool.query(
      `UPDATE objects SET values = jsonb_set(values, '{homeAddress}', to_jsonb(left(values->>'homeAddress', length(values->>'homeAddress') - 4) || 'AAAA')) WHERE object_id = 'p1'`
    );
    await expect(adapter.resolveProperties("fleet.Pilot", "p1", [])).rejects.toBeInstanceOf(DecryptionError);
  });
});
