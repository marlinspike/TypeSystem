import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { computeAggregations } from "../src/runtime/query-ops.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError, InvalidInputError, AggregationNotSupportedError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter, SemanticAggregateQuery, AggregateResult } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

class RepoAdapter implements Adapter {
  constructor(readonly dataSourceId: string) {}
  private readonly data = new Map<string, Map<string, Record<string, unknown>>>();

  seed(type: string, records: { objectId: string; values: Record<string, unknown> }[]): void {
    const m = this.data.get(type) ?? new Map<string, Record<string, unknown>>();
    for (const r of records) m.set(r.objectId, r.values);
    this.data.set(type, m);
  }
  private rows(type: string): { objectId: string; values: Record<string, unknown> }[] {
    return [...(this.data.get(type)?.entries() ?? [])].map(([objectId, values]) => ({ objectId, values }));
  }
  async resolveProperties(type: string, id: string): Promise<ResolvedProperties> {
    return { values: { ...(this.data.get(type)?.get(id) ?? {}) }, provenance: [] };
  }
  async queryByType(type: string, filter?: QueryFilter, limit?: number, cursor?: string): Promise<AdapterQueryResult> {
    const all = this.rows(type);
    const filtered = filter ? all.filter((r) => matchesFilter(r.values, filter)) : all;
    const start = cursor ? Number(cursor) : 0;
    const page = filtered.slice(start, start + (limit ?? filtered.length));
    return { items: page.map((r) => ({ objectId: r.objectId, values: { ...r.values }, provenance: [] })) };
  }
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    const all = this.rows(query.type).map((r) => r.values);
    const filtered = query.filter ? all.filter((v) => matchesFilter(v, query.filter)) : all;
    return computeAggregations(filtered, query);
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

/** Same as RepoAdapter but WITHOUT `aggregate`, to prove the not-supported path. */
class NoAggregateAdapter implements Adapter {
  readonly dataSourceId = "ds2";
  async resolveProperties(): Promise<ResolvedProperties> {
    return { values: {}, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} }; // not a manager

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());

  const empSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Emp/1.0.0",
    title: "Emp",
    type: "object",
    properties: {
      name: { type: "string" },
      dept: { type: "string" },
      salary: { type: "number" },
      ssn: { type: "string" },
      note: { type: "string" }
    },
    "x-computed": { label: { dependsOn: [], binding: "label" } },
    "x-policy": { objectPolicy: "public", propertyPolicies: { ssn: "managers-only" } }
  };
  await registry.registerType(empSchema, {
    name: "test.Emp",
    version: "1.0.0",
    computedImplementations: { label: async () => "x" }
  });
  await registry.registerMapping({ id: "map-emp", typeName: "test.Emp", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });

  const noAggSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/NoAgg/1.0.0",
    title: "NoAgg",
    type: "object",
    properties: { id: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(noAggSchema, { name: "test.NoAgg", version: "1.0.0" });
  await registry.registerMapping({ id: "map-noagg", typeName: "test.NoAgg", target: "property", targetName: "*", dataSourceId: "ds2", operation: "get", resolutionMode: "live" });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("managers-only", requireRole("manager"));

  const adapter = new RepoAdapter("ds");
  adapter.seed("test.Emp", [
    { objectId: "e1", values: { name: "Alice", dept: "eng", salary: 100, ssn: "111", note: "loves TypeScript" } },
    { objectId: "e2", values: { name: "Bob", dept: "eng", salary: 200, ssn: "222", note: "writes Rust" } },
    { objectId: "e3", values: { name: "Carol", dept: "sales", salary: 150, ssn: "333", note: "typescript fan" } }
  ]);
  const runtime = new SemanticRuntime(registry, [adapter, new NoAggregateAdapter()], policyEngine);
  return { runtime };
}

describe("Query aggregation (ADR-0027)", () => {
  it("counts all rows as a single group", async () => {
    const { runtime } = await setup();
    const r = await runtime.aggregate({ type: "test.Emp", aggregations: [{ name: "n", op: "count" }] }, identity);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.values.n).toBe(3);
  });

  it("groups by a property and counts / sums per group", async () => {
    const { runtime } = await setup();
    const r = await runtime.aggregate(
      { type: "test.Emp", groupBy: ["dept"], aggregations: [{ name: "headcount", op: "count" }, { name: "payroll", op: "sum", property: "salary" }] },
      identity
    );
    const byDept: Record<string, Record<string, number>> = {};
    for (const g of r.groups) byDept[String(g.key.dept)] = g.values;
    expect(byDept.eng).toEqual({ headcount: 2, payroll: 300 });
    expect(byDept.sales).toEqual({ headcount: 1, payroll: 150 });
  });

  it("computes sum/avg/min/max over a numeric property", async () => {
    const { runtime } = await setup();
    const r = await runtime.aggregate(
      { type: "test.Emp", aggregations: [
        { name: "total", op: "sum", property: "salary" },
        { name: "mean", op: "avg", property: "salary" },
        { name: "lo", op: "min", property: "salary" },
        { name: "hi", op: "max", property: "salary" }
      ] },
      identity
    );
    expect(r.groups[0]!.values).toEqual({ total: 450, mean: 150, lo: 100, hi: 200 });
  });

  it("rejects grouping/aggregating on a computed property", async () => {
    const { runtime } = await setup();
    await expect(runtime.aggregate({ type: "test.Emp", groupBy: ["label"], aggregations: [{ name: "n", op: "count" }] }, identity)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("denies aggregating over a property the caller cannot read (fail closed)", async () => {
    const { runtime } = await setup();
    await expect(runtime.aggregate({ type: "test.Emp", groupBy: ["ssn"], aggregations: [{ name: "n", op: "count" }] }, identity)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("reports a clear error when the data source can't aggregate", async () => {
    const { runtime } = await setup();
    await expect(runtime.aggregate({ type: "test.NoAgg", aggregations: [{ name: "n", op: "count" }] }, identity)).rejects.toBeInstanceOf(AggregationNotSupportedError);
  });
});

const ids = (r: { items: { objectId: string }[] }) => r.items.map((i) => i.objectId).sort();

describe("Query full-text search (ADR-0027)", () => {
  it("finds matches case-insensitively across the type's readable properties", async () => {
    const { runtime } = await setup();
    expect(ids(await runtime.query({ type: "test.Emp", search: { text: "typescript" } }, identity))).toEqual(["e1", "e3"]);
  });

  it("does not search a policy-gated property when properties are omitted", async () => {
    const { runtime } = await setup();
    // "111" is e1's ssn (gated); an omitted-properties search must not reach it.
    expect(ids(await runtime.query({ type: "test.Emp", search: { text: "111" } }, identity))).toEqual([]);
  });

  it("denies an explicit search on a property the caller cannot read", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "test.Emp", search: { text: "111", properties: ["ssn"] } }, identity)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("searches an explicitly named property, case-insensitively", async () => {
    const { runtime } = await setup();
    expect(ids(await runtime.query({ type: "test.Emp", search: { text: "RUST", properties: ["note"] } }, identity))).toEqual(["e2"]);
  });

  it("AND-combines search with an explicit filter", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Emp", filter: { property: "dept", operator: "eq", value: "eng" }, search: { text: "typescript" } }, identity);
    expect(ids(r)).toEqual(["e1"]); // e3 also matches the text but is in sales
  });

  it("supports icontains as a direct filter operator", async () => {
    const { runtime } = await setup();
    expect(ids(await runtime.query({ type: "test.Emp", filter: { property: "note", operator: "icontains", value: "rust" } }, identity))).toEqual(["e2"]);
  });
});
