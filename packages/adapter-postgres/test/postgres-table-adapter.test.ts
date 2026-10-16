import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AdapterUnavailableError, isRetryableError, type RelationshipDefinition } from "@typesys/core";
import { PostgresTableAdapter } from "../src/index.js";

/**
 * Another system's tables as objects (ADR-0076): read-only, parameterized,
 * with the table's codes, padding and numerics converted as the mapping
 * says. Database-free checks run everywhere; the rest need DATABASE_URL.
 */
const url = process.env.DATABASE_URL;

describe("PostgresTableAdapter", () => {
  it("refuses a table or column name that is not an identifier when it is built", () => {
    const pool = {} as pg.Pool;
    expect(() => new PostgresTableAdapter(pool, { dataSourceId: "d", system: "S", types: { "t.A": { table: "a; DROP TABLE x", id: "id", columns: {} } } })).toThrow(/t\.A: .* is not a table or column name/);
    expect(() => new PostgresTableAdapter(pool, { dataSourceId: "d", system: "S", types: { "t.A": { table: "s.a", id: "id", columns: { x: 'x"y' } } } })).toThrow(/not a table or column name/);
  });

  it("implements no Actions: it never writes another system's tables", async () => {
    const a = new PostgresTableAdapter({} as pg.Pool, { dataSourceId: "d", system: "S", types: {} });
    await expect(a.executeAction({ name: "Write" } as never)).rejects.toThrow(/implements no Actions/);
  });

  describe.skipIf(!url)("against a live database", () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: url });
      await pool.query(`DROP SCHEMA IF EXISTS pta CASCADE; CREATE SCHEMA pta;
        CREATE TABLE pta.unit (cd char(6) PRIMARY KEY, nm text);
        CREATE TABLE pta.item (id integer PRIMARY KEY, unit_cd char(6) REFERENCES pta.unit, st char(1), qty numeric(6,1), seen date);
        INSERT INTO pta.unit VALUES ('388FW', 'Fighter Wing'), ('419FW', NULL);
        INSERT INTO pta.item VALUES (1, '388FW', 'A', 12.5, '2026-09-30'), (2, '388FW', 'Z', NULL, NULL), (3, '419FW', 'R', 3, '2026-01-02');`);
    });
    afterAll(async () => {
      await pool?.query("DROP SCHEMA IF EXISTS pta CASCADE");
      await pool?.end();
    });
    const adapter = (maxRows?: number) =>
      new PostgresTableAdapter(pool, {
        dataSourceId: "pta",
        system: "PTA",
        ...(maxRows ? { maxRows } : {}),
        types: {
          "t.Unit": { table: "pta.unit", id: "cd", columns: { code: "cd", name: "nm" } },
          "t.Item": { table: "pta.item", id: "id", columns: { unit: "unit_cd", status: { column: "st", map: { A: "active", R: "retired" } }, quantity: { column: "qty", as: "number" }, seen: { column: "seen", as: "date" } } }
        }
      });

    it("trims char padding, translates codes (leaving out an unlisted one), reads numerics and dates, and cites the column", async () => {
      const a = adapter();
      const one = await a.resolveProperties("t.Item", "1", []);
      expect(one.values).toEqual({ unit: "388FW", status: "active", quantity: 12.5, seen: "2026-09-30" });
      expect(one.provenance[0]!.source).toMatchObject({ dataSourceId: "pta", recordId: "1", field: "pta.item.unit_cd" });
      expect((await a.resolveProperties("t.Item", "2", [])).values).toEqual({ unit: "388FW" });
      expect((await a.resolveProperties("t.Unit", "388FW", [])).values).toEqual({ code: "388FW", name: "Fighter Wing" });
      expect((await a.resolveProperties("t.Item", "99", [])).values).toEqual({});
    });

    it("queries with every condition decided as the runtime decides it, sorts and pages", async () => {
      const a = adapter();
      const r = await a.queryByType("t.Item", { and: [{ property: "unit", operator: "eq", value: "388FW" }, { property: "status", operator: "eq", value: "active" }] });
      expect(r.items.map((o) => o.objectId)).toEqual(["1"]);
      const page = await a.queryByType("t.Item", undefined, 2, undefined, [{ property: "unit", direction: "desc" }]);
      expect(page.items.map((o) => o.objectId)).toEqual(["3", "1"]);
      expect(page.nextCursor).toBe("2");
    });

    it("follows a foreign key and an own field", async () => {
      const a = adapter();
      const rel = (operation: string, sourceType: string, targetType: string) => ({ name: "r", sourceType, targetType, cardinality: "many", resolution: { dataSourceId: "pta", operation } }) as unknown as RelationshipDefinition;
      expect(await a.resolveRelationship(rel("byForeignKey:unit", "t.Unit", "t.Item"), "388FW")).toEqual([{ objectId: "1" }, { objectId: "2" }]);
      expect(await a.resolveRelationship(rel("byOwnField:unit", "t.Item", "t.Unit"), "3")).toEqual([{ objectId: "419FW" }]);
    });

    it("refuses to answer from a partial list rather than truncate it, and says retrying will not help", async () => {
      const err = await adapter(2).queryByType("t.Item").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdapterUnavailableError);
      expect(isRetryableError(err)).toBe(false);
    });
  });
});
