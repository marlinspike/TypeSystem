import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SOURCE_WITHHELD, SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort } from "../src/runtime/query-ops.js";
import { splitFilter } from "../src/runtime/execution-plan.js";
import { AbacPolicyEngine, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { InvalidInputError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter, SemanticQuery, SortKey } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { QueryLimits } from "../src/runtime/input-validation.js";
import type { ComputeContext } from "../src/model/context.js";

/**
 * ADR-0054: the part of a filter that names computed properties runs in the
 * runtime, and pages are refilled from the adapter until full. Checked here
 * against a brute-force reference over generated queries: every page sequence
 * returns exactly the matching readable rows, in order, once each.
 */
class OffsetAdapter implements Adapter {
  readonly dataSourceId = "ds";
  readonly filtersSeen: (QueryFilter | undefined)[] = [];
  constructor(readonly rows: Record<string, unknown>[]) {}

  async resolveProperties(_t: string, id: string): Promise<ResolvedProperties> {
    const row = this.rows.find((r) => r.id === id);
    return { values: row ? { ...row } : {}, provenance: [] };
  }
  async queryByType(_t: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    this.filtersSeen.push(filter);
    const matching = this.rows.filter((r) => matchesFilter(r, filter));
    const ordered = sort ? applySort(matching, sort, (r) => r) : matching;
    const start = cursor ? Number(cursor) : 0;
    const end = limit === undefined ? ordered.length : start + limit;
    const items = ordered.slice(start, end).map((r) => ({ objectId: r.id as string, values: { ...r }, provenance: [] }));
    return { items, ...(end < ordered.length ? { nextCursor: String(end) } : {}) };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("none");
  }
}

const reader: Identity = { subjectId: "r", roles: ["reader"], attributes: {} };

// Rows whose `n` is a multiple of 7 are hidden from everyone but a reader of "all", decided per object.
const hidesSevens: PolicyRule = (req) => {
  if (req.resource.attributes === undefined) return { allow: true };
  return Number(req.resource.attributes.n) % 7 === 0 && !req.subject.roles.includes("all") ? { allow: false, reason: "hidden" } : { allow: true };
};

const computed = {
  parity: async (ctx: ComputeContext) => (Number(await ctx.getProperty("n")) % 2 === 0 ? "even" : "odd"),
  bucket: async (ctx: ComputeContext) => Math.floor(Number(await ctx.getProperty("n")) / 10)
};

async function setup(rows: Record<string, unknown>[], limits: Partial<QueryLimits> = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/t/Row/1.0.0",
      title: "Row",
      type: "object",
      properties: { id: { type: "string" }, n: { type: "integer" }, tag: { type: "string" } },
      "x-computed": { parity: { dependsOn: ["n"], binding: "parity" }, bucket: { dependsOn: ["n"], binding: "bucket" } },
      "x-policy": { objectPolicy: "rows" }
    },
    { name: "t.Row", version: "1.0.0", computedImplementations: computed }
  );
  await registry.registerMapping({ id: "m", typeName: "t.Row", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  const policy = new AbacPolicyEngine();
  policy.registerRule("rows", (req) => (req.subject.roles.includes("reader") ? hidesSevens(req) : { allow: false, reason: "no" }));
  const adapter = new OffsetAdapter(rows);
  return { runtime: new SemanticRuntime(registry, [adapter], policy, { queryLimits: limits }), adapter };
}

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, n: i, tag: ["a", "b", "c"][i % 3]! }));

async function drain(runtime: SemanticRuntime, query: SemanticQuery): Promise<{ ids: string[]; calls: number }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let calls = 0;
  do {
    const page = await runtime.query({ ...query, ...(cursor ? { cursor } : {}) }, reader);
    calls++;
    expect(page.items.length).toBeLessThanOrEqual(query.limit ?? 100);
    ids.push(...page.items.map((i) => i.objectId));
    cursor = page.nextCursor;
    if (calls > 500) throw new Error("did not terminate");
  } while (cursor);
  return { ids, calls };
}

/** What the query should return: readable rows matching the whole filter on their computed values, in adapter order. */
function reference(rows: Record<string, unknown>[], filter: QueryFilter, sort?: SortKey[]): string[] {
  const finalized = rows
    .filter((r) => Number(r.n) % 7 !== 0)
    .map((r): Record<string, unknown> => ({ ...r, parity: Number(r.n) % 2 === 0 ? "even" : "odd", bucket: Math.floor(Number(r.n) / 10) }));
  const ordered = sort ? applySort(finalized, sort, (r) => r) : finalized;
  return ordered.filter((r) => matchesFilter(r, filter)).map((r) => String(r.id));
}

describe("Filtering on computed properties (ADR-0054)", () => {
  it("returns exactly the matching rows across pages, in order, once each", async () => {
    const rows = rowsOf(57);
    const { runtime } = await setup(rows);
    const filter: QueryFilter = { property: "parity", operator: "eq", value: "even" };
    for (const limit of [1, 2, 3, 5, 8, 50, 100]) {
      const { ids } = await drain(runtime, { type: "t.Row", filter, limit });
      expect(ids, `limit ${limit}`).toEqual(reference(rows, filter));
    }
  });

  it("agrees with the reference over generated filters, limits and sorts", async () => {
    const rows = rowsOf(43);
    const { runtime } = await setup(rows);
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const atoms: QueryFilter[] = [
      { property: "parity", operator: "eq", value: "odd" },
      { property: "bucket", operator: "in", value: [0, 2, 4] },
      { property: "bucket", operator: "gte", value: 3 },
      { property: "tag", operator: "eq", value: "b" },
      { property: "n", operator: "lt", value: 30 },
      { property: "tag", operator: "ne", value: "a" }
    ];
    for (let round = 0; round < 60; round++) {
      const pick = () => atoms[rand(atoms.length)]!;
      const shapes: QueryFilter[] = [pick(), { and: [pick(), pick()] }, { or: [pick(), pick()] }, { and: [pick(), { or: [pick(), pick()] }] }];
      const filter = shapes[rand(shapes.length)]!;
      const sort: SortKey[] | undefined = rand(2) === 0 ? [{ property: "tag", direction: "desc" }, { property: "n" }] : undefined;
      const limit = 1 + rand(9);
      const { ids } = await drain(runtime, { type: "t.Row", filter, limit, ...(sort ? { sort } : {}) });
      expect(ids, JSON.stringify({ filter, limit, sort })).toEqual(reference(rows, filter, sort));
    }
  });

  it("pushes the stored conjuncts to the adapter and keeps the computed ones, never splitting an or", async () => {
    const { runtime, adapter } = await setup(rowsOf(10));
    await runtime.query({ type: "t.Row", filter: { and: [{ property: "tag", operator: "eq", value: "a" }, { property: "parity", operator: "eq", value: "odd" }] } }, reader);
    expect(adapter.filtersSeen.at(-1)).toEqual({ property: "tag", operator: "eq", value: "a" });
    await runtime.query({ type: "t.Row", filter: { or: [{ property: "tag", operator: "eq", value: "a" }, { property: "parity", operator: "eq", value: "odd" }] } }, reader);
    expect(adapter.filtersSeen.at(-1)).toBeUndefined();
  });

  it("stops after maxScanned rows with a short page and a cursor that resumes exactly there", async () => {
    const rows = rowsOf(40);
    const { runtime, adapter } = await setup(rows, { maxScanned: 6 });
    const filter: QueryFilter = { property: "bucket", operator: "eq", value: 3 };
    const first = await runtime.query({ type: "t.Row", filter, limit: 5 }, reader);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const before = adapter.filtersSeen.length;
    const { ids } = await drain(runtime, { type: "t.Row", filter, limit: 5 });
    expect(ids).toEqual(reference(rows, filter));
    expect(adapter.filtersSeen.length).toBeGreaterThan(before);
  });

  it("resumes mid-page when an adapter returns more rows than asked for", async () => {
    const rows = rowsOf(50);
    const { runtime, adapter } = await setup(rows);
    // An adapter is told a page size; one that returns more (a fixed server page, say) must not lose or repeat rows.
    const original = adapter.queryByType.bind(adapter);
    adapter.queryByType = (t, filter, limit, cursor, sort) => original(t, filter, limit === undefined ? undefined : limit + 3, cursor, sort);
    for (const limit of [1, 2, 4]) {
      const filter: QueryFilter = { property: "parity", operator: "eq", value: "odd" };
      const { ids } = await drain(runtime, { type: "t.Row", filter, limit });
      expect(ids, `limit ${limit}`).toEqual(reference(rows, filter));
    }
  });

  it("refuses a cursor it didn't issue, and a scan cursor on a query that doesn't scan", async () => {
    const { runtime } = await setup(rowsOf(20));
    const residual: QueryFilter = { property: "parity", operator: "eq", value: "odd" };
    await expect(runtime.query({ type: "t.Row", filter: residual, cursor: "3" }, reader)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(runtime.query({ type: "t.Row", filter: residual, cursor: "ts1.%%%" }, reader)).rejects.toBeInstanceOf(InvalidInputError);
    const page = await runtime.query({ type: "t.Row", filter: residual, limit: 2 }, reader);
    await expect(runtime.query({ type: "t.Row", cursor: page.nextCursor! }, reader)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("explains exactly the split it runs", async () => {
    const { runtime, adapter } = await setup(rowsOf(10));
    const filter: QueryFilter = { and: [{ property: "n", operator: "gt", value: 2 }, { or: [{ property: "parity", operator: "eq", value: "odd" }, { property: "tag", operator: "eq", value: "c" }] }] };
    const report = await runtime.explainQuery({ type: "t.Row", filter, select: ["n"] }, reader);
    expect(adapter.filtersSeen).toEqual([]); // explaining reads nothing
    await runtime.query({ type: "t.Row", filter }, reader);
    const scan = report.execution.steps.find((s) => s.op === "scan");
    const residual = report.execution.steps.find((s) => s.op === "residual-filter");
    // Which source is scanned is told only to an inspector (ADR-0088), and nobody inspects this runtime.
    expect(scan).toMatchObject({ op: "scan", dataSourceId: SOURCE_WITHHELD, pushdownFilter: adapter.filtersSeen[0] });
    expect(residual).toEqual({ op: "residual-filter", filter: splitFilter(filter, (p) => p === "parity" || p === "bucket").residual, maxScanned: 1000 });
    expect(report.execution.steps.map((s) => s.op)).toEqual(["classification-gate", "scan", "authorize-rows", "compute", "redact", "residual-filter", "project"]);
    expect(report.execution.notes.join(" ")).toMatch(/runs after each object is read/);
  });

  it("splits only at the top-level conjunction", () => {
    const computedName = (p: string) => p === "c";
    expect(splitFilter({ and: [{ and: [{ property: "s", operator: "eq", value: 1 }, { property: "c", operator: "eq", value: 2 }] }, { property: "t", operator: "eq", value: 3 }] }, computedName)).toEqual({
      pushdown: { and: [{ property: "s", operator: "eq", value: 1 }, { property: "t", operator: "eq", value: 3 }] },
      residual: { property: "c", operator: "eq", value: 2 }
    });
    expect(splitFilter({ property: "s", operator: "eq", value: 1 }, computedName)).toEqual({ pushdown: { property: "s", operator: "eq", value: 1 } });
    expect(splitFilter(undefined, computedName)).toEqual({});
  });
});

