import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import pg from "pg";
import { applySort, computeAggregations, matchesFilter, type QueryFilter, type RelationshipDefinition, type SortKey } from "@typesys/core";
import { PostgresTableAdapter } from "../src/index.js";

/**
 * ADR-0122: an existing table of any size is served by the table adapter.
 * A page reads what it returns, a key is found through its index, a foreign
 * key is followed without reading the table, and whatever SQL decides, the
 * answer is the one `matchesFilter`, `applySort` and `computeAggregations`
 * give over every row. Needs DATABASE_URL.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("the table adapter on a large table (ADR-0122)", () => {
  let pool: pg.Pool;
  const statements: string[] = [];
  const ROWS = 25_000;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(`DROP SCHEMA IF EXISTS pts CASCADE; CREATE SCHEMA pts;
      CREATE TABLE pts.customer (customer_id integer PRIMARY KEY, name text, tier char(6));
      CREATE TABLE pts.ord (order_id text PRIMARY KEY, customer_id integer REFERENCES pts.customer, status text, total numeric(12,2), qty int8, placed timestamptz, flagged boolean);
      CREATE INDEX ON pts.ord (customer_id);
      INSERT INTO pts.customer VALUES (1, 'Ada', 'gold'), (2, 'Bob', 'silver'), (3, NULL, NULL);
      INSERT INTO pts.ord SELECT 'O' || lpad(g::text, 6, '0'), 1 + (g % 2), CASE g % 3 WHEN 0 THEN 'open' WHEN 1 THEN 'closed' ELSE NULL END,
        (g % 997) / 4.0, CASE WHEN g = 7 THEN 9007199254740993 ELSE g END, timestamptz '2026-01-01' + g * interval '1 minute', g % 5 = 0
        FROM generate_series(1, ${ROWS}) g;
      ANALYZE pts.ord; ANALYZE pts.customer;`);
  });
  afterAll(async () => {
    await pool?.query("DROP SCHEMA IF EXISTS pts CASCADE");
    await pool?.end();
  });

  /** The pool, with every statement it is sent remembered. */
  const recording = (): pg.Pool =>
    new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") return (text: string, values?: unknown[]) => (statements.push(text), target.query(text, values));
        return Reflect.get(target, prop, receiver) as unknown;
      }
    });

  const adapter = (maxRows?: number) =>
    new PostgresTableAdapter(recording(), {
      dataSourceId: "pts",
      system: "PTS",
      ...(maxRows ? { maxRows } : {}),
      types: {
        "t.Customer": { table: "pts.customer", id: "customer_id", columns: { customerId: "customer_id", name: "name", tier: "tier" } },
        "t.Order": {
          table: "pts.ord",
          id: "order_id",
          columns: {
            orderId: "order_id",
            customerId: "customer_id",
            status: "status",
            total: { column: "total", as: "number" },
            qty: { column: "qty", as: "integer" },
            placed: { column: "placed", as: "date-time" },
            flagged: "flagged"
          }
        }
      }
    });

  it("pages a table far past the old 10,000-row cap, reading only what a page needs", async () => {
    const a = adapter(1_000);
    const first = await a.queryByType("t.Order", undefined, 5);
    expect(first.items.map((o) => o.objectId)).toEqual(["O000001", "O000002", "O000003", "O000004", "O000005"]);
    const open = await a.queryByType("t.Order", { property: "status", operator: "eq", value: "open" }, 3, first.nextCursor === undefined ? undefined : "0");
    expect(open.items.map((o) => o.values.status)).toEqual(["open", "open", "open"]);
    const next = await a.queryByType("t.Order", { property: "status", operator: "eq", value: "open" }, 3, open.nextCursor);
    expect(next.items.map((o) => o.objectId)).toEqual(["O000012", "O000015", "O000018"]);
    const last = await a.queryByType("t.Order", undefined, 2, undefined, [{ property: "total", direction: "desc" }, { property: "placed", direction: "desc" }]);
    expect(last.items.map((o) => o.values.total)).toEqual([249, 249]);
  });

  it("finds an object by id, and a foreign key's targets, through their indexes", async () => {
    const a = adapter(1_000);
    statements.length = 0;
    expect((await a.resolveProperties("t.Order", "O012345", [])).values).toMatchObject({ orderId: "O012345", customerId: 2, status: "open" });
    expect((await a.resolveProperties("t.Customer", "2", [])).values).toEqual({ customerId: 2, name: "Bob", tier: "silver" });
    // An id that only looks like one is no object: not "02", not "2.0", not a value no integer column can hold.
    for (const id of ["02", "2.0", "x", "99999999999999999999"]) expect((await a.resolveProperties("t.Customer", id, [])).values).toEqual({});
    const rel = { name: "orders", sourceType: "t.Customer", targetType: "t.Order", cardinality: "many", resolution: { dataSourceId: "pts", operation: "byForeignKey:customerId" } } as unknown as RelationshipDefinition;
    const refs = await adapter().resolveRelationship(rel, "1");
    expect(refs).toHaveLength(ROWS / 2);
    expect(refs[0]).toEqual({ objectId: "O000002" });
    // Each lookup can be served by an index: with sequential scans priced out, the plan uses one (a three-row table would rightly be scanned).
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      for (const text of statements.filter((s) => s.includes("WHERE") && !s.includes("pg_attribute"))) {
        const plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${text.replace(/\$1::(\w+)/, "'2'::$1")}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        expect(plan, text).toMatch(/Index/);
      }
    } finally {
      client.release();
    }
  });

  it("leaves out a bigint JavaScript cannot hold exactly instead of rounding it", async () => {
    expect((await adapter().resolveProperties("t.Order", "O000007", [])).values.qty).toBeUndefined();
    expect((await adapter().resolveProperties("t.Order", "O000008", [])).values.qty).toBe(8);
  });

  it("aggregates over exactly the rows a query returns", async () => {
    const a = adapter();
    const filter: QueryFilter = { and: [{ property: "flagged", operator: "eq", value: true }, { property: "total", operator: "gte", value: 100 }] };
    const result = await a.aggregate({ type: "t.Order", filter, groupBy: ["status"], aggregations: [{ name: "n", op: "count" }, { name: "sum", op: "sum", property: "total" }] });
    const all = await a.queryByType("t.Order", filter);
    expect(result).toEqual(computeAggregations(all.items.map((o) => o.values), { groupBy: ["status"], aggregations: [{ name: "n", op: "count" }, { name: "sum", op: "sum", property: "total" }] }));
    expect(result.groups.reduce((n, g) => n + g.values.n!, 0)).toBe(all.items.length);
  });

  it("answers every filter, sort and page as the runtime's own interpreter does over the whole table", async () => {
    const a = adapter();
    const everything = (await a.queryByType("t.Order", undefined)).items;
    expect(everything).toHaveLength(ROWS);
    const value = fc.oneof(
      fc.constantFrom("open", "closed", "O000010", "", "OPEN"),
      fc.integer({ min: -2, max: 2 }),
      fc.constantFrom(0, 1, 2, 12.25, 12.5, 248.75, 249, 1e300, -0, 0.1, 9007199254740993),
      fc.boolean(),
      fc.constant(null)
    );
    const property = fc.constantFrom("orderId", "customerId", "status", "total", "qty", "placed", "flagged", "missing");
    const condition = fc.record({ property, operator: fc.constantFrom("eq", "ne", "gt", "gte", "lt", "lte", "in", "icontains" as const), value }).map((c) =>
      c.operator === "in" ? { ...c, value: [c.value, "open", 2] } : c.operator === "icontains" ? { ...c, value: String(c.value) } : c
    ) as fc.Arbitrary<QueryFilter>;
    const filter = fc.oneof(condition, fc.array(condition, { minLength: 1, maxLength: 3 }).map((and) => ({ and })), fc.array(condition, { minLength: 1, maxLength: 3 }).map((or) => ({ or })));
    const sortKey = fc.record({ property: fc.constantFrom("status", "total", "placed", "flagged", "orderId", "qty", "customerId"), direction: fc.constantFrom("asc", "desc" as const) }) as fc.Arbitrary<SortKey>;
    await fc.assert(
      fc.asyncProperty(fc.option(filter, { nil: undefined }), fc.array(sortKey, { maxLength: 2 }), fc.integer({ min: 1, max: 40 }), async (f, sort, limit) => {
        const expected = applySort(
          everything.filter((o) => matchesFilter(o.values, f)),
          sort,
          (o) => o.values
        ).map((o) => o.objectId);
        // Read two pages through the cursor and compare them with the same slice of the expected order.
        const p1 = await a.queryByType("t.Order", f, limit, undefined, sort);
        const p2 = p1.nextCursor ? await a.queryByType("t.Order", f, limit, p1.nextCursor, sort) : { items: [] };
        const got = [...p1.items, ...p2.items].map((o) => o.objectId);
        // Equal sort keys may tie in either order between adapters, so compare the sort keys and the set of ids.
        const keyOf = (id: string) => JSON.stringify(sort.map((k) => everything.find((o) => o.objectId === id)!.values[k.property] ?? null));
        expect(got.map(keyOf)).toEqual(expected.slice(0, got.length).map(keyOf));
        expect(got.length).toBe(Math.min(expected.length, 2 * limit));
        expect(new Set(got).size).toBe(got.length);
        expect(got.every((id) => expected.includes(id))).toBe(true);
      }),
      { numRuns: 40 }
    );
  }, 120_000);
});
