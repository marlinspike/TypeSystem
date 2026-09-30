import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { matchesFilter, type QueryFilter, type QueryOperator } from "@typesys/core";
import { exactDecimal, nextDown, nextUp } from "../src/double.js";
import { PostgresRepositoryAdapter } from "../src/postgres-repository-adapter.js";
import { runMigrations } from "../src/migrate.js";
import { createPool } from "../src/pool.js";

/**
 * ADR-0044: numeric conditions are bounded in exact decimal arithmetic by a
 * double's neighbors, so SQL never excludes a stored number JavaScript would
 * match — whatever Postgres's floating-point input does.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
/** A spread of doubles: small, large, fractional, subnormal, negative, and the edges. */
function doubles(next: () => number, n: number): number[] {
  const out = [0, 1, -1, 0.1, 0.30000000000000004, 1e21, 5e-324, -5e-324, Number.MAX_VALUE, -Number.MAX_VALUE, 2 ** 53, 2 ** 53 + 2, 1.5, 2.5];
  for (let i = 0; i < n; i++) {
    const kind = next();
    const x = kind < 0.3 ? Math.round(next() * 1000) - 500 : kind < 0.6 ? (next() - 0.5) * 10 ** Math.floor(next() * 40 - 20) : kind < 0.8 ? next() * 1e-310 : (next() - 0.5) * 1e300;
    out.push(x);
  }
  return out;
}

/** (a + b) / 2 for exact decimal strings, exactly. */
function midpoint(a: string, b: string): string {
  const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0) + 1;
  const toInt = (d: string) => {
    const negative = d.startsWith("-");
    const [whole, frac = ""] = d.replace("-", "").split(".");
    const v = BigInt(whole! + frac.padEnd(scale, "0"));
    return negative ? -v : v;
  };
  const sum = (toInt(a) + toInt(b)) * 5n; // ÷2 at one more decimal place
  const negative = sum < 0n;
  const digits = (negative ? -sum : sum).toString().padStart(scale + 2, "0");
  const out = `${digits.slice(0, digits.length - scale - 1)}.${digits.slice(digits.length - scale - 1)}`.replace(/\.?0+$/, "");
  return negative ? `-${out}` : out;
}

describe("exact facts about doubles (ADR-0044)", () => {
  it("writes a double's exact decimal value", () => {
    expect(exactDecimal(0.1)).toBe("0.1000000000000000055511151231257827021181583404541015625");
    expect(exactDecimal(-2.5)).toBe("-2.5");
    expect(exactDecimal(1e21)).toBe("1000000000000000000000");
    expect(exactDecimal(0)).toBe("0");
    expect(exactDecimal(-0)).toBe("0");
    // The smallest subnormal, 2^-1074: 1,074 digits after the point, 323 of them leading zeros.
    expect(exactDecimal(5e-324)).toMatch(/^0\.0{323}49406564584124654[0-9]{734}$/);
    expect(() => exactDecimal(Number.NaN)).toThrow(RangeError);
  });

  it("parses back to itself, and neighbors are neighbors, for thousands of doubles", () => {
    for (const x of doubles(rng(44), 3000)) {
      expect(Number(exactDecimal(x))).toBe(x);
      if (Math.abs(x) < Number.MAX_VALUE) {
        expect(nextDown(nextUp(x))).toBe(x === 0 ? 0 : x);
        expect(nextUp(x)).toBeGreaterThan(x);
        expect(nextDown(x)).toBeLessThan(x);
      }
    }
    expect(nextUp(1)).toBe(1 + Number.EPSILON);
    expect(nextUp(0)).toBe(Number.MIN_VALUE);
    expect(nextUp(Number.MAX_VALUE)).toBe(Number.POSITIVE_INFINITY);
    expect(nextDown(-Number.MAX_VALUE)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("the midpoint helper is exact", () => {
    expect(midpoint("1", "2")).toBe("1.5");
    expect(midpoint("-1", "0.5")).toBe("-0.25");
    expect(Number(midpoint(exactDecimal(1), exactDecimal(nextUp(1))))).toBe(1); // a tie rounds to even
  });
});

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const TYPE = "pushdown.Number";

describe.skipIf(!hasDb)("numeric bounds against PostgreSQL (ADR-0044)", () => {
  let pool: Pool;
  let adapter: PostgresRepositoryAdapter;
  const values = doubles(rng(4444), 30);

  beforeAll(async () => {
    pool = createPool();
    await runMigrations(pool);
    await pool.query(`DELETE FROM objects WHERE type_name = $1`, [TYPE]);
    // Stored decimals right at, between, around, and far beyond the doubles being compared — written raw,
    // as a store written around the adapter would hold them.
    const stored = new Set<string>(["1e400", "-1e400", "1e-400", "0.1000000000000000000001", "0.30000000000000004440892098500626161694526672363281", "123456789012345678901234567890"]);
    for (const v of values) {
      for (const [a, b] of [[nextDown(v), v], [v, nextUp(v)]]) {
        if (!Number.isFinite(a!) || !Number.isFinite(b!)) continue;
        const mid = midpoint(exactDecimal(a!), exactDecimal(b!));
        stored.add(mid);
        stored.add(`${mid}${mid.includes(".") ? "" : "."}000000000000000000000001`);
        stored.add(exactDecimal(a!));
      }
    }
    let i = 0;
    for (const decimal of stored) await pool.query(`INSERT INTO objects (type_name, object_id, values) VALUES ($1, $2, $3::jsonb)`, [TYPE, `n${String(i++).padStart(4, "0")}`, `{"n": ${decimal}}`]);
    adapter = new PostgresRepositoryAdapter(pool, "pg");
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM objects WHERE type_name = $1`, [TYPE]);
    await pool.end();
  });

  it("every numeric condition returns exactly what JavaScript's view of the stored numbers matches", async () => {
    const all = (await adapter.queryByType(TYPE)).items;
    expect(all.length).toBeGreaterThan(150);
    const operators: QueryOperator[] = ["eq", "ne", "gt", "gte", "lt", "lte", "in"];
    let checked = 0;
    for (const v of values) {
      for (const probe of [v, nextUp(v), nextDown(v)]) {
        if (!Number.isFinite(probe)) continue;
        for (const operator of operators) {
          const f: QueryFilter = { property: "n", operator, value: operator === "in" ? [probe, 12345] : probe };
          const expected = all.filter((i) => matchesFilter(i.values, f)).map((i) => i.objectId);
          expect((await adapter.queryByType(TYPE, f, 10_000)).items.map((i) => i.objectId)).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  }, 180_000);
});
