import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { applySort, computeAggregations, matchesFilter, type QueryFilter, type QueryOperator, type SortKey } from "@typesys/core";
import { PostgresRepositoryAdapter } from "../src/postgres-repository-adapter.js";
import { compileFilter, SqlParams } from "../src/sql-filter.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

/**
 * ADR-0040: the filter DSL compiled to SQL, exactly or as a superset, against
 * a real PostgreSQL. The contract that matters: the adapter returns exactly
 * what `matchesFilter` over every row would — never fewer, since a pushed
 * authorization plan that lost a row would hide data the caller may read.
 */
const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const TYPE = "pushdown.Row";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const PROPS = ["s", "n", "b", "arr", "mixed", "__proto__", "we'ird\"key"];
/**
 * Values chosen for where JSONB and JavaScript part ways: "7" and 7, 0.1+0.2, case and Unicode, nesting,
 * null. Each use is a fresh copy, as values from a database or a JSON request always are — `===` on
 * arrays and objects compares references.
 */
const SAMPLES: unknown[] = ["a", "A", "ab", "", "7", "Straße", "İstanbul", 7, 0, -1, 0.1, 0.30000000000000004, 1e21, true, false, null, ["a", "b"], [["a"]], [7], { a: 1 }];
const pick = (next: () => number): unknown => structuredClone(SAMPLES[Math.floor(next() * SAMPLES.length)]);
const OPS: QueryOperator[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains"];

function row(next: () => number): Record<string, unknown> {
  const values: Record<string, unknown> = JSON.parse("{}") as Record<string, unknown>;
  for (const p of PROPS) {
    if (next() < 0.65) Object.defineProperty(values, p, { value: pick(next), enumerable: true, writable: true, configurable: true });
  }
  return values;
}
function filter(next: () => number, depth = 0): QueryFilter {
  const r = next();
  if (depth > 2 || r < 0.5) {
    const operator = OPS[Math.floor(next() * OPS.length)]!;
    const value = operator === "in" && next() < 0.8 ? [pick(next), pick(next)] : pick(next);
    return { property: PROPS[Math.floor(next() * PROPS.length)]!, operator, value };
  }
  const children = Array.from({ length: Math.floor(next() * 3) }, () => filter(next, depth + 1));
  return r < 0.75 ? { and: children } : { or: children };
}

describe("the filter compiler (ADR-0040)", () => {
  it("binds every property name and value as a parameter, never into the SQL text", () => {
    const params = new SqlParams(["T"]);
    const evil = `x'); DROP TABLE objects; --`;
    const { sql } = compileFilter({ or: [{ property: evil, operator: "eq", value: evil }, { property: evil, operator: "gt", value: 1 }, { property: evil, operator: "contains", value: evil }] }, params);
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain(evil);
    expect(params.values.filter((v) => typeof v === "string" && v.includes("DROP")).length).toBeGreaterThan(0);
  });

  it("marks exact only what needs no numeric parsing — string, boolean, and null equality (ADR-0044)", () => {
    const exact = (f: QueryFilter) => compileFilter(f, new SqlParams()).exact;
    for (const value of ["a", true, null]) {
      for (const operator of ["eq", "ne"] as const) expect(exact({ property: "p", operator, value })).toBe(true);
    }
    expect(exact({ property: "p", operator: "in", value: ["a", false, null] })).toBe(true);
    for (const operator of ["eq", "ne", "gt", "gte", "lt", "lte"] as const) expect(exact({ property: "p", operator, value: 1 })).toBe(false);
    expect(exact({ property: "p", operator: "in", value: ["a", 1] })).toBe(false);
    expect(compileFilter({ property: "p", operator: "gt", value: 1 }, new SqlParams()).sql).not.toContain("float8");
    expect(exact({ property: "p", operator: "contains", value: "a" })).toBe(false);
    expect(exact({ property: "p", operator: "icontains", value: "a" })).toBe(false);
    expect(exact({ property: "p", operator: "gt", value: Number.POSITIVE_INFINITY })).toBe(false);
    // Nothing compares greater than NaN, and nothing but a number compares at all: no SQL needed.
    for (const value of [Number.NaN, "7", null]) expect(compileFilter({ property: "p", operator: "gt", value }, new SqlParams())).toEqual({ sql: "FALSE", exact: true });
    expect(exact({ and: [{ property: "p", operator: "eq", value: "a" }, { property: "q", operator: "icontains", value: "a" }] })).toBe(false);
  });
});

describe.skipIf(!hasDb)("SQL pushdown against PostgreSQL (ADR-0040)", () => {
  let pool: Pool;
  let adapter: PostgresRepositoryAdapter;
  const sqlSeen: string[] = [];
  const rows: { id: string; values: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    await pool.query(`DELETE FROM objects WHERE type_name = $1`, [TYPE]);
    const next = rng(40);
    for (let i = 0; i < 150; i++) rows.push({ id: `r${String(i).padStart(3, "0")}`, values: row(next) });
    const seeding = new PostgresRepositoryAdapter(pool, "pg");
    for (const r of rows) await seeding.put(TYPE, r.id, r.values);
    // Everything below reads through a pool that records its SQL.
    const recording = Object.assign(Object.create(pool) as Pool, {
      query: (text: string, values?: unknown[]) => (sqlSeen.push(text), pool.query(text, values))
    });
    adapter = new PostgresRepositoryAdapter(recording, "pg");
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM objects WHERE type_name = $1`, [TYPE]);
    await pool.end();
  });

  /** What matchesFilter over every row returns, in the adapter's base order. */
  const reference = (f: QueryFilter | undefined, sort?: SortKey[]) => applySort(rows.filter((r) => matchesFilter(r.values, f)), sort, (r) => r.values).map((r) => r.id);

  async function walk(f: QueryFilter | undefined, limit: number, sort?: SortKey[]) {
    const ids: string[] = [];
    const pages: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.queryByType(TYPE, f, limit, cursor, sort);
      ids.push(...page.items.map((i) => i.objectId));
      pages.push(page.items.length);
      cursor = page.nextCursor;
    } while (cursor);
    return { ids, pages };
  }

  it("returns exactly what matchesFilter returns, over 400 generated filters, walked page by page", async () => {
    const next = rng(4040);
    let narrowed = 0;
    for (let i = 0; i < 400; i++) {
      const f = filter(next);
      const limit = [1, 7, 1000][i % 3]!;
      const { ids, pages } = await walk(f, limit);
      expect(ids).toEqual(reference(f));
      // Where the compiler claims exactness, SQL paged it: every page but the last is full.
      // …and there is no trailing empty page: a cursor is only handed out when another row follows.
      if (compileFilter(f, new SqlParams()).exact) {
        expect(pages.slice(0, -1).every((n) => n === limit)).toBe(true);
        expect(pages).toHaveLength(Math.max(1, Math.ceil(ids.length / limit)));
      }
      if (ids.length < rows.length) narrowed++;
    }
    expect(narrowed).toBeGreaterThan(200); // not vacuous
  }, 120_000); // 400 filters, each walked to the end against a real database

  it("…with a sort, too", async () => {
    const next = rng(8040);
    for (let i = 0; i < 60; i++) {
      const f = filter(next);
      const sort: SortKey[] = [{ property: PROPS[i % PROPS.length]!, direction: i % 2 ? "desc" : "asc" }];
      expect((await walk(f, 5, sort)).ids).toEqual(reference(f, sort));
    }
  });

  it("an exact filter pages in SQL: full pages, and only the page's rows read", async () => {
    const f: QueryFilter = { or: ["a", "A", "ab", "7", ""].map((value) => ({ property: "s", operator: "eq" as const, value })) };
    const expected = reference(f);
    expect(expected.length).toBeGreaterThan(3);
    sqlSeen.length = 0;
    const { ids, pages } = await walk(f, 2);
    expect(ids).toEqual(expected);
    expect(pages.slice(0, -1).every((n) => n === 2)).toBe(true);
    expect(sqlSeen.every((q) => /LIMIT \$\d+ OFFSET \$\d+/.test(q) && q.includes("@>"))).toBe(true);
  });

  it("a superset filter narrows in SQL and is decided in JavaScript", async () => {
    const f: QueryFilter = { property: "s", operator: "icontains", value: "ST" };
    sqlSeen.length = 0;
    const { ids } = await walk(f, 3);
    expect(ids).toEqual(reference(f));
    expect(sqlSeen.every((q) => q.includes("jsonb_typeof") && !q.includes("LIMIT"))).toBe(true);
  });

  it("aggregates over exactly the filtered rows", async () => {
    const next = rng(12040);
    for (let i = 0; i < 40; i++) {
      const f = filter(next);
      const query = { type: TYPE, filter: f, groupBy: ["b"], aggregations: [{ name: "n", op: "count" as const }] };
      expect(await adapter.aggregate(query)).toEqual(computeAggregations(rows.map((r) => r.values).filter((v) => matchesFilter(v, f)), query));
    }
  });

  it("a number stored with more precision than a double compares as JavaScript reads it (ADR-0044)", async () => {
    await pool.query(`INSERT INTO objects (type_name, object_id, values) VALUES ($1, 'precise', '{"n": 0.1000000000000000000001}'::jsonb)`, [TYPE]);
    try {
      for (const f of [
        { property: "n", operator: "eq", value: 0.1 },
        { property: "n", operator: "lte", value: 0.1 },
        { property: "n", operator: "in", value: [0.1] }
      ] as QueryFilter[]) {
        expect((await adapter.queryByType(TYPE, f, 1000)).items.map((i) => i.objectId)).toContain("precise");
      }
      expect((await adapter.queryByType(TYPE, { property: "n", operator: "ne", value: 0.1 }, 1000)).items.map((i) => i.objectId)).not.toContain("precise");
    } finally {
      await pool.query(`DELETE FROM objects WHERE type_name = $1 AND object_id = 'precise'`, [TYPE]);
    }
  });

  it("attack: a property name or value built to inject SQL is data, and the table survives", async () => {
    const evil = `s' = 'a' OR 1=1; DROP TABLE objects; --`;
    for (const f of [
      { property: evil, operator: "eq", value: "a" },
      { property: "s", operator: "eq", value: evil },
      { property: evil, operator: "gt", value: 1 },
      { property: "s", operator: "in", value: [evil, "a"] }
    ] as QueryFilter[]) {
      expect((await walk(f, 1000)).ids).toEqual(reference(f));
    }
    const { rows: count } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM objects WHERE type_name = $1`, [TYPE]);
    expect(Number(count[0]!.n)).toBe(rows.length);
  });

  it("string equality is answerable from the GIN index", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const params = new SqlParams();
      const { sql } = compileFilter({ property: "s", operator: "eq", value: "a" }, params);
      // Without the type_name prefix the primary key can't help, so an index answer must come from GIN.
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT object_id FROM objects WHERE ${sql}`, params.values);
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("idx_objects_values");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  });
});
