import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { ComputeContext } from "../src/model/context.js";

/** Runtime-level pressure on ADR-0062 coalescing: per-request isolation, budget interplay, error handling. */
function build(mode: "direct" | "coalesce", maxConcurrency = 1) {
  const rows = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < 12; i++) rows.set(`u${i}`, { name: `n${i}`, owner: i % 2 === 0 ? "ann" : "bob" });
  const events = [...Array(30).keys()].map((i) => ({ objectId: `e${i}`, values: { unitId: `u${i % 12}`, by: i % 3 === 0 ? "ann" : "bob" } }));
  let failNext = 0;
  const calls: string[] = [];
  const adapter: Adapter = {
    dataSourceId: "ds",
    async resolveProperties(_t, id): Promise<ResolvedProperties> {
      return { values: { ...rows.get(id) }, provenance: [] };
    },
    async queryByType(t, filter?: QueryFilter): Promise<AdapterQueryResult> {
      calls.push(`${t}:${JSON.stringify(filter)}`);
      await new Promise((r) => setTimeout(r, 1));
      if (t === "Event") {
        if (failNext > 0) {
          failNext--;
          throw new Error("transient");
        }
        return { items: events.filter((e) => !filter || matchesFilter(e.values, filter)).map((e) => ({ ...e, values: { ...e.values }, provenance: [] })) };
      }
      return { items: [...rows.entries()].map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] })).filter((i) => !filter || matchesFilter(i.values, filter)) };
    },
    async resolveRelationship() {
      return [];
    },
    async executeAction() {
      return undefined;
    }
  };
  return {
    calls,
    failOnce: () => (failNext = 1),
    async runtime() {
      const registry = new SemanticRegistry(new InMemoryRegistryStore());
      await registry.registerType(
        {
          $id: "https://typesys.dev/types/c/Unit/1.0.0",
          title: "Unit",
          type: "object",
          properties: { name: { type: "string" }, owner: { type: "string" } },
          "x-computed": { mine: { dependsOn: [], binding: "mine" } },
          "x-policy": { objectPolicy: "readers" }
        },
        {
          name: "c.Unit",
          version: "1.0.0",
          computedImplementations: {
            // Identity-dependent derivation: the events of this unit recorded by the caller.
            mine: async (ctx: ComputeContext) => {
              const r = await ctx.getAdapter("ds").queryByType("Event", { property: "unitId", operator: "eq", value: ctx.objectId });
              return r.items.filter((e) => e.values.by === ctx.identity.subjectId).length;
            }
          }
        }
      );
      await registry.registerMapping({ id: "m", typeName: "c.Unit", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
      const policy = new AbacPolicyEngine();
      policy.registerRule("readers", requireRole("reader"));
      return new SemanticRuntime(registry, [adapter], policy, { computedReads: mode, maxConcurrency });
    }
  };
}

const ann: Identity = { subjectId: "ann", roles: ["reader"], attributes: {} };
const bob: Identity = { subjectId: "bob", roles: ["reader"], attributes: {} };

describe("ADR-0062 pressure (runtime level)", () => {
  it("[HOLDS] concurrent requests by different callers get exactly what direct reads give, under a budget of 1", async () => {
    const d = build("direct");
    const c = build("coalesce");
    const rd = await d.runtime();
    const rc = await c.runtime();
    const [da, db] = await Promise.all([rd.query({ type: "c.Unit", limit: 50 }, ann), rd.query({ type: "c.Unit", limit: 50 }, bob)]);
    const [ca, cb] = await Promise.all([rc.query({ type: "c.Unit", limit: 50 }, ann), rc.query({ type: "c.Unit", limit: 50 }, bob)]);
    expect(ca.items.map((i) => i.values.mine)).toEqual(da.items.map((i) => i.values.mine));
    expect(cb.items.map((i) => i.values.mine)).toEqual(db.items.map((i) => i.values.mine));
    // (With a budget of 1 objects are read one at a time, so nothing coalesces; correctness is what matters here.)
    const c8 = build("coalesce", 8);
    const d8 = build("direct", 8);
    await (await c8.runtime()).query({ type: "c.Unit", limit: 50 }, ann);
    await (await d8.runtime()).query({ type: "c.Unit", limit: 50 }, ann);
    expect(c8.calls.length).toBeLessThan(d8.calls.length);
  });

  it("[HOLDS] nothing is shared across requests: a second request sees fresh data", async () => {
    const c = build("coalesce");
    const rc = await c.runtime();
    await rc.getObject("c.Unit", "u0", ann);
    const before = c.calls.length;
    await rc.getObject("c.Unit", "u0", ann);
    expect(c.calls.length).toBeGreaterThan(before);
  });

  it("[HOLDS] a failed combined read is not remembered for later requests", async () => {
    const c = build("coalesce");
    const rc = await c.runtime();
    c.failOnce();
    await rc.query({ type: "c.Unit", limit: 50 }, ann).catch(() => undefined);
    const ok = await rc.query({ type: "c.Unit", limit: 50 }, ann);
    expect(ok.items).toHaveLength(12);
  });
});
