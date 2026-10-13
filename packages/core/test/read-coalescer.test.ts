import { describe, it, expect } from "vitest";
import type { Adapter, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { QueryFilter, QueryOperator } from "../src/model/query.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { ReadCoalescer } from "../src/runtime/read-coalescer.js";

type Row = { objectId: string; values: Record<string, unknown> };

/** An adapter over `rows` that records every call it receives. */
function recording(rows: Row[], opts: { canFilter?: Adapter["canFilter"]; sensitiveFields?: Adapter["sensitiveFields"]; pageSize?: number; failIn?: boolean } = {}) {
  const calls: { method: string; filter?: QueryFilter | undefined; limit?: number | undefined }[] = [];
  const adapter: Adapter = {
    dataSourceId: "src",
    async resolveProperties(_t, id) {
      calls.push({ method: "resolveProperties" });
      const row = rows.find((r) => r.objectId === id);
      return { values: { ...row?.values }, provenance: [] };
    },
    async queryByType(_t, filter, limit) {
      calls.push({ method: "queryByType", filter, limit });
      if (opts.failIn && filter && "operator" in filter && filter.operator === "in") throw new Error("in is not supported here");
      const matching = rows.filter((r) => !filter || matchesFilter(r.values, filter)).map((r) => ({ objectId: r.objectId, values: structuredClone(r.values), provenance: [] }));
      const page = limit ?? opts.pageSize;
      return page !== undefined && matching.length > page ? { items: matching.slice(0, page), nextCursor: "next" } : { items: matching };
    },
    async resolveRelationship() {
      return [];
    },
    async executeAction() {
      return undefined;
    },
    ...(opts.canFilter ? { canFilter: opts.canFilter } : {}),
    ...(opts.sensitiveFields ? { sensitiveFields: opts.sensitiveFields } : {})
  };
  return { adapter, calls };
}

const EVENTS: Row[] = [
  { objectId: "E1", values: { aircraftId: "A1", kind: "inspection" } },
  { objectId: "E2", values: { aircraftId: "A2", kind: "repair" } },
  { objectId: "E3", values: { aircraftId: "A1", kind: "repair" } },
  { objectId: "E4", values: { aircraftId: 1, kind: "numeric key" } },
  { objectId: "E5", values: { aircraftId: "1", kind: "string key" } }
];

const eq = (value: unknown): QueryFilter => ({ property: "aircraftId", operator: "eq", value });

/** What each lookup would have returned straight from the adapter. */
async function direct(rows: Row[], filters: QueryFilter[]): Promise<AdapterQueryResult[]> {
  const { adapter } = recording(rows);
  return Promise.all(filters.map((f) => adapter.queryByType("Event", f)));
}

describe("coalesced reads for computed properties (ADR-0062)", () => {
  it("turns concurrent equality lookups into one membership query, each caller getting exactly its own answer", async () => {
    const { adapter, calls } = recording(EVENTS);
    const view = new ReadCoalescer().view(adapter);
    const filters = ["A1", "A2", "A9", 1, "1", "A1"].map(eq);
    const answers = await Promise.all(filters.map((f) => view.queryByType("Event", f)));
    expect(answers).toEqual(await direct(EVENTS, filters));
    expect(calls).toEqual([{ method: "queryByType", filter: { property: "aircraftId", operator: "in", value: ["A1", "A2", "A9", 1, "1"] }, limit: undefined }]);
  });

  it("makes an identical read once per request, which no computation can change for another", async () => {
    const { adapter, calls } = recording(EVENTS);
    const view = new ReadCoalescer().view(adapter);
    const [a, b] = await Promise.all([view.queryByType("Event"), view.queryByType("Event")]);
    const c = await view.queryByType("Event");
    expect(calls.filter((x) => x.method === "queryByType")).toHaveLength(1);
    expect(() => (a.items[0]!.values.kind = "changed by one computation")).toThrow(TypeError);
    expect(() => a.items.pop()).toThrow(TypeError);
    expect(b.items[0]!.values.kind).toBe("inspection");
    expect(c.items).toHaveLength(EVENTS.length);
    const [one] = await Promise.all(["A1", "A2"].map((v) => view.queryByType("Event", eq(v))));
    expect(() => (one!.items[0]!.values.kind = "x")).toThrow(TypeError);
    await Promise.all([view.resolveProperties("Event", "E1", ["kind"]), view.resolveProperties("Event", "E1", ["kind"])]);
    await view.resolveProperties("Event", "E2", ["kind"]);
    expect(calls.filter((x) => x.method === "resolveProperties")).toHaveLength(2);
  });

  it("never freezes or shares the adapter's own records", async () => {
    const rows: Row[] = [{ objectId: "E1", values: { aircraftId: "A1", tags: ["a"] } }, { objectId: "E2", values: { aircraftId: "A2", tags: ["b"] } }];
    const shallow: Adapter = { ...recording(rows).adapter, queryByType: async () => ({ items: rows.map((r) => ({ objectId: r.objectId, values: { ...r.values }, provenance: [] })) }) };
    const view = new ReadCoalescer().view(shallow);
    await view.queryByType("Event");
    await Promise.all(["A1", "A2"].map((v) => view.queryByType("Event", eq(v))));
    expect(Object.isFrozen(rows[0]!.values.tags)).toBe(false);
    expect(Object.isFrozen(rows[1]!.values.tags)).toBe(false);
  });

  it("shares nothing between requests", async () => {
    const { adapter, calls } = recording(EVENTS);
    await new ReadCoalescer().view(adapter).queryByType("Event");
    await new ReadCoalescer().view(adapter).queryByType("Event");
    expect(calls).toHaveLength(2);
  });

  it("batches only equality: any other condition is read as asked, once", async () => {
    const { adapter, calls } = recording(EVENTS);
    const view = new ReadCoalescer().view(adapter);
    const lookups: QueryFilter[] = [
      { property: "aircraftId", operator: "ne", value: "A1" },
      { property: "aircraftId", operator: "ne", value: "A2" },
      { property: "kind", operator: "icontains", value: "REP" }
    ];
    expect(await Promise.all(lookups.map((f) => view.queryByType("Event", f)))).toEqual(await direct(EVENTS, lookups));
    expect(calls.map((c) => c.filter)).toEqual(lookups);
  });

  it("passes a limited, sorted or paged query through as the caller's own", async () => {
    const { adapter, calls } = recording(EVENTS);
    const view = new ReadCoalescer().view(adapter);
    await Promise.all([view.queryByType("Event", eq("A1"), 1), view.queryByType("Event", eq("A2"), undefined, "c"), view.queryByType("Event", eq("A2"), undefined, undefined, [{ property: "kind" }])]);
    expect(calls.map((c) => (c.filter as { operator: string }).operator)).toEqual(["eq", "eq", "eq"]);
  });

  it("asks one by one where the adapter cannot filter the property exactly", async () => {
    const lookups = ["A1", "A2"].map(eq);
    const refusals: [string, Parameters<typeof recording>[1]][] = [
      ["membership not supported", { canFilter: (_t: string, _p: string, op: QueryOperator) => op === "eq" }],
      ["equality not supported", { canFilter: (_t: string, _p: string, op: QueryOperator) => op === "in" }],
      ["the property is protected at rest", { sensitiveFields: () => ["aircraftId"] }],
      ["the adapter's answer is not a list", { sensitiveFields: () => "everything" as unknown as string[] }],
      ["the adapter's answer throws", { canFilter: () => { throw new Error("down"); } }]
    ];
    for (const [why, opts] of refusals) {
      const { adapter, calls } = recording(EVENTS, opts);
      const view = new ReadCoalescer().view(adapter);
      const answers = await Promise.all(lookups.map((f) => view.queryByType("Event", f)));
      expect(answers, why).toEqual(await direct(EVENTS, lookups));
      expect(calls.map((c) => (c.filter as { operator: string }).operator), why).toEqual(["eq", "eq"]);
    }
    const { adapter, calls } = recording(EVENTS, { canFilter: () => true, sensitiveFields: () => ["kind"] });
    const view = new ReadCoalescer().view(adapter);
    await Promise.all(lookups.map((f) => view.queryByType("Event", f)));
    expect(calls.map((c) => (c.filter as { operator: string }).operator)).toEqual(["in"]);
  });

  it("falls back to each caller's own query when the combined answer is paged or fails", async () => {
    const lookups = ["A1", "A2"].map(eq);
    for (const opts of [{ pageSize: 2 }, { failIn: true }]) {
      const { adapter, calls } = recording(EVENTS, opts);
      const view = new ReadCoalescer().view(adapter);
      const answers = await Promise.all(lookups.map((f) => view.queryByType("Event", f)));
      expect(answers).toEqual(await Promise.all(lookups.map((f) => recording(EVENTS, opts).adapter.queryByType("Event", f))));
      expect(calls.map((c) => (c.filter as { operator: string }).operator)).toEqual(["in", "eq", "eq"]);
    }
  });

  it("does not remember a failed read", async () => {
    let fail = true;
    const { adapter } = recording(EVENTS);
    const flaky: Adapter = { ...adapter, queryByType: (...args) => (fail ? Promise.reject(new Error("timeout")) : adapter.queryByType(...args)) };
    const view = new ReadCoalescer().view(flaky);
    await expect(view.queryByType("Event")).rejects.toThrow("timeout");
    fail = false;
    expect((await view.queryByType("Event")).items).toHaveLength(EVENTS.length);
  });
});
