import { describe, expect, it } from "vitest";
import { $, ALL_ROWS_CAP, RetryableStepError, UnknownValueError, assertHolds, forEachBounded, need, orUnknown, parallel, rows, within } from "../src/index.js";

const U = undefined;

describe("three-valued operators (ADR-0079)", () => {
  it("is unknown when an operand is, unless the answer does not depend on it", () => {
    expect($.eq(U, 1)).toBeUndefined();
    expect($.eq(null, null)).toBe(true);
    expect($.eq({ a: [1] }, { a: [1] })).toBe(true);
    expect($.ne("a", "b")).toBe(true);
    expect($.and(false, U)).toBe(false);
    expect($.and(true, U)).toBeUndefined();
    expect($.and(true, true)).toBe(true);
    expect($.or(true, U)).toBe(true);
    expect($.or(false, U)).toBeUndefined();
    expect($.not(U)).toBeUndefined();
    expect($.exists(null)).toBe(false);
    expect($.exists(0)).toBe(true);
  });

  it("acts on a condition only when it holds", () => {
    expect($.cond(U, "warn", "good")).toBe("good");
    expect($.cond(true, "warn", "good")).toBe("warn");
    expect($.holds(U)).toBe(false);
    expect(() => assertHolds(U, "must be degraded")).toThrow(/may not read/);
    expect(() => assertHolds(false, "must be degraded")).toThrow("must be degraded");
  });

  it("orders numbers and date-times, and nothing else", () => {
    expect($.lt(1, 2)).toBe(true);
    expect($.gte("2026-10-16T10:00:00Z", "2026-10-16T09:00:00Z")).toBe(true);
    expect($.lt(null, 2)).toBeUndefined();
    expect($.lt("soon", "later")).toBeUndefined();
  });

  it("finds in a list only what is known to be there", () => {
    expect($.inList("b", ["a", "b"])).toBe(true);
    expect($.inList("c", ["a", U])).toBeUndefined();
    expect($.inList("c", ["a", "b"])).toBe(false);
    expect($.inList(U, ["a"])).toBeUndefined();
  });

  it("does arithmetic on known numbers, and never divides by zero", () => {
    expect($.add(1, 2, 3)).toBe(6);
    expect($.add(1, U)).toBeUndefined();
    expect($.div(1, 0)).toBeUndefined();
    expect($.round(2.345, 2)).toBe(2.35);
    expect($.concat("Lot ", 7)).toBe("Lot 7");
    expect($.concat("Lot ", U)).toBeUndefined();
    expect($.coalesce(U, null, 3)).toBe(3);
  });

  it("totals a list only when every value in it is known", () => {
    const rows = [{ n: 2 }, { n: 3 }];
    expect($.count(rows)).toBe(2);
    expect($.sum(rows, "n")).toBe(5);
    expect($.sum([], "n")).toBe(0);
    expect($.sum([{ n: 2 }, {}], "n")).toBeUndefined();
    expect($.avg(rows, "n")).toBe(2.5);
    expect($.avg([], "n")).toBeUndefined();
    expect($.max([4, 9, 1])).toBe(9);
    expect($.where(rows, (r) => $.gt(r.n, 2))).toEqual([{ n: 3 }]);
    // P4-06, P4-21: an element whose predicate is unknown makes the selection unknown, so a count over it is not a confident understatement.
    expect($.where([{ n: U }, { n: 3 }], (r) => $.gt(r.n, 2))).toBeUndefined();
    expect($.count($.where([{ n: U }, { n: 3 }], (r) => $.gt(r.n, 2)))).toBeUndefined();
    // P4-05: only dates written as dates are ordered; Date.parse would order "12" and "Bravo 7" as years.
    expect($.gt("2026-10-17T00:00:00Z", "Bravo 7")).toBeUndefined();
    expect($.lt("5", "10")).toBeUndefined();
    expect($.lt("2026-10-16", "2026-10-17T08:00:00Z")).toBe(true);
    expect($.pluck(rows, "n")).toEqual([2, 3]);
    expect($.count(U)).toBeUndefined();
  });

  it("measures hours from a time, against the clock it is given", () => {
    expect($.hoursSince("2026-10-16T00:00:00Z", () => Date.parse("2026-10-16T06:00:00Z"))).toBe(6);
    expect($.hoursSince("not a date")).toBeUndefined();
  });
});

describe("flow helpers (ADR-0081)", () => {
  it("fails a step on an unknown value it needs, naming it", () => {
    expect(need("x", "$aircraft.tailNumber")).toBe("x");
    expect(() => need(U, "$aircraft.tailNumber")).toThrow(UnknownValueError);
  });

  it("fails a slow read retryably", async () => {
    await expect(within(5, "sensor readings", () => new Promise((r) => setTimeout(r, 200)))).rejects.toBeInstanceOf(RetryableStepError);
    await expect(within(200, "sensor readings", async () => 7)).resolves.toBe(7);
  });

  it("carries on from a source failure, never from a refusal", async () => {
    const unavailable = Object.assign(new Error("down"), { name: "AdapterUnavailableError", retryable: true });
    const refused = Object.assign(new Error("no"), { name: "AuthorizationError" });
    await expect(orUnknown(() => Promise.reject(unavailable))).resolves.toBeUndefined();
    await expect(orUnknown(() => Promise.reject(refused))).rejects.toBe(refused);
  });

  it("reads at most max elements, in order, and refuses a longer list", async () => {
    let running = 0;
    let peak = 0;
    const read = async (n: number) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    };
    expect(await forEachBounded([1, 2, 3, 4, 5], 5, 2, read, "$lots")).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
    await expect(forEachBounded([1, 2, 3], 2, 2, read, "$lots")).rejects.toThrow(/more than the 2/);
  });

  it("runs a parallel step's reads at once, each by its name", async () => {
    expect(await parallel({ a: async () => 1, b: async () => "two" })).toEqual({ a: 1, b: "two" });
  });
});

describe("rows (P4-26)", () => {
  // Pages of 1000 rows, `total` in all.
  const pages = (total: number) => ({
    page: async (cursor?: string) => {
      const from = Number(cursor ?? 0);
      const items = Array.from({ length: Math.min(1000, total - from) }, (_, i) => from + i);
      return from + 1000 < total ? { items, nextCursor: String(from + 1000) } : { items };
    }
  });
  it("refuses a result the cap would cut rather than shortening it", async () => {
    expect(await rows(pages(ALL_ROWS_CAP), { all: true })).toHaveLength(ALL_ROWS_CAP);
    await expect(rows(pages(ALL_ROWS_CAP + 1), { all: true })).rejects.toThrow(/more than 10000 rows/);
  });
  it("keeps a limit the read names", async () => {
    expect(await rows(pages(ALL_ROWS_CAP + 1), { all: true, limit: 1500 })).toHaveLength(1500);
  });
});
