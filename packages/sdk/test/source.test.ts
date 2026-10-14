import { describe, it, expect } from "vitest";
import { canonical, type QueryFilter, type QueryInclude, type SemanticQuery } from "@typesys/core";
import { createClient, querySource, type Transport } from "../src/index.js";

/** A transport that is never called: the code is only built and turned back into a query. */
const client = createClient(new Proxy({}, { get: () => () => Promise.reject(new Error("not called")) }) as Transport);

/** The query the builder would produce: conjunctions and disjunctions flattened, singletons unwrapped, sort direction explicit. */
function normal(q: SemanticQuery | QueryInclude): unknown {
  const filter = (f: QueryFilter): QueryFilter => {
    if ("and" in f || "or" in f) {
      const op = "and" in f ? "and" : "or";
      const parts = ("and" in f ? f.and : f.or).map(filter).flatMap((p) => (op in p ? (p as Record<string, QueryFilter[]>)[op]! : [p]));
      return parts.length === 1 ? parts[0]! : op === "and" ? { and: parts } : { or: parts };
    }
    return f;
  };
  const { cursor: _cursor, ...rest } = q as SemanticQuery;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      ...(q.filter ? { filter: filter(q.filter) } : {}),
      ...(q.sort ? { sort: q.sort.map((s) => ({ property: s.property, direction: s.direction ?? "asc" })) } : {}),
      ...(q.include ? { include: q.include.map(normal) } : {})
    })
  ) as unknown;
}

/** A seeded generator of arbitrary queries over arbitrary names, including names that are not identifiers. */
function generator(seed: number) {
  let s = seed >>> 0;
  const rand = () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 2 ** 32);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const names = ["status", "tailNumber", "needsAttention", "x-ray", "class", "$id2", "a b", "größe"];
  const values = [true, false, 0, -1.5, 42, "F-16C", 'quote " and \\ slash', "", null, ["a", "b"], [1, 2]];
  const condition = (): QueryFilter => ({ property: pick(names), operator: pick(["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "icontains"] as const), value: pick(values) });
  const filter = (depth: number): QueryFilter => {
    if (depth === 0 || rand() < 0.4) return condition();
    const parts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => filter(depth - 1));
    return rand() < 0.5 ? { and: parts } : { or: parts };
  };
  const include = (depth: number): QueryInclude => ({
    relationship: pick(["components", "maintenance", "work-order"]),
    ...(rand() < 0.5 ? { filter: filter(2) } : {}),
    ...(rand() < 0.3 ? { sort: [{ property: pick(names), direction: pick(["asc", "desc"] as const) }] } : {}),
    ...(rand() < 0.3 ? { select: [pick(names)] } : {}),
    ...(rand() < 0.3 ? { limit: 1 + Math.floor(rand() * 9) } : {}),
    ...(depth > 0 && rand() < 0.4 ? { include: [include(depth - 1)] } : {})
  });
  return (): SemanticQuery => ({
    type: pick(["airforce.Aircraft", "hospital.Patient", "x.Odd-Name"]),
    ...(rand() < 0.7 ? { filter: filter(3) } : {}),
    ...(rand() < 0.2 ? { search: rand() < 0.5 ? { text: "viper" } : { text: "viper", properties: [pick(names)] } } : {}),
    ...(rand() < 0.4 ? { sort: [{ property: pick(names), direction: pick(["asc", "desc"] as const) }, ...(rand() < 0.3 ? [{ property: pick(names) }] : [])] } : {}),
    ...(rand() < 0.4 ? { select: [pick(names), pick(names)].filter((n, i, a) => a.indexOf(n) === i) } : {}),
    ...(rand() < 0.4 ? { include: [include(2)].filter((v, i, a) => a.findIndex((x) => x.relationship === v.relationship) === i) } : {}),
    ...(rand() < 0.5 ? { limit: 1 + Math.floor(rand() * 100) } : {}),
    ...(rand() < 0.2 ? { includeProvenance: true } : {}),
    ...(rand() < 0.1 ? { cursor: "abc" } : {})
  });
}

describe("querySource (ADR-0061)", () => {
  it("writes the SDK code for a query, readably", () => {
    const code = querySource({
      type: "airforce.Aircraft",
      filter: { and: [{ property: "needsAttention", operator: "eq", value: true }, { or: [{ property: "model", operator: "eq", value: "F-16C" }, { property: "model", operator: "eq", value: "F-15E" }] }] },
      sort: [{ property: "tailNumber", direction: "desc" }],
      select: ["tailNumber", "readinessStatus"],
      include: [{ relationship: "maintenance", include: [{ relationship: "workOrder" }] }],
      limit: 25
    }, { client: "af" });
    expect(code).toBe(
      [
        'af.from("airforce.Aircraft")',
        '  .where((f) => f.needsAttention.eq(true).and(f.model.eq("F-16C").or(f.model.eq("F-15E"))))',
        '  .orderBy("tailNumber", "desc")',
        '  .select("tailNumber", "readinessStatus")',
        '  .include("maintenance", (q) => q.include("workOrder"))',
        "  .limit(25)"
      ].join("\n")
    );
  });

  it("builds exactly the query it was written from, over 2,000 generated queries", () => {
    const next = generator(20261013);
    const mismatches: unknown[] = [];
    for (let i = 0; i < 2000; i++) {
      const query = next();
      const code = querySource(query);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating generated code is the point of the test
      const built = (new Function("client", `return ${code};`) as (c: typeof client) => { toQuery(): SemanticQuery })(client).toQuery();
      if (canonical(normal(built)) !== canonical(normal(query))) mismatches.push({ query, code, built });
    }
    expect(mismatches.length, JSON.stringify(mismatches.slice(0, 1), null, 1)).toBe(0);
  });

  it("refuses a filter the builder cannot express", () => {
    expect(() => querySource({ type: "t", filter: { and: [] } })).toThrow(/empty "and"/);
  });
});
