import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort, computeAggregations } from "../src/runtime/query-ops.js";
import { AbacPolicyEngine, allOf, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { ALWAYS, NEVER, isExact } from "../src/policy/authorization-plan.js";
import { AuthorizationError, AuthorizationPlanError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { AggregateResult, QueryFilter, SemanticAggregateQuery, SortKey } from "../src/model/query.js";
import type { Identity, PolicyEngine, PolicyRequest } from "../src/model/policy.js";

/**
 * ADR-0038 at the runtime: the read policy's plan is fitted to where the data
 * is, pushed into the adapter's filter, applied before aggregation when it is
 * exact, and refused under `require-exact` when it isn't — while the post-read
 * check keeps deciding every object it admits.
 */
const CASES: Record<string, Record<string, unknown>> = {
  c1: { id: "c1", ownerId: "alice", reviewerId: "bob", title: "Leak in lab" },
  c2: { id: "c2", ownerId: "bob", title: "Broken badge" },
  c3: { id: "c3", ownerId: "carol", title: "Server fire" },
  c4: { id: "c4", ownerId: "bob", title: "Flickering light" },
  c5: { id: "c5", ownerId: "dave", reviewerId: "bob", title: "Loose tile" }
};
/** A second data source, which supplies each Case's `escalatedTo` (ADR-0023). */
const ESCALATIONS: Record<string, Record<string, unknown>> = { c3: { escalatedTo: "alice" }, c4: { escalatedTo: "erin" } };

class RecordingAdapter implements Adapter {
  readonly queried: (QueryFilter | undefined)[] = [];
  readonly aggregated: (QueryFilter | undefined)[] = [];
  constructor(
    readonly dataSourceId: string,
    private readonly rows: Record<string, Record<string, unknown>>,
    private readonly protects: readonly string[] = []
  ) {}
  private items() {
    return Object.entries(this.rows).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] }));
  }
  async resolveProperties(_type: string, id: string): Promise<ResolvedProperties> {
    return { values: { ...(this.rows[id] ?? {}) }, provenance: [] };
  }
  async queryByType(_type: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    this.queried.push(filter);
    const all = applySort(this.items().filter((i) => matchesFilter(i.values, filter)), sort ?? [{ property: "id" }], (i) => i.values);
    const start = cursor ? Number(cursor) : 0;
    const end = start + (limit ?? all.length);
    return { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : undefined };
  }
  async resolveRelationship() {
    return [];
  }
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    this.aggregated.push(query.filter);
    return computeAggregations(this.items().map((i) => i.values).filter((v) => matchesFilter(v, query.filter)), query);
  }
  async executeAction(): Promise<unknown> {
    return {};
  }
  sensitiveFields(): readonly string[] {
    return this.protects;
  }
}

const who = (userId: string | undefined, roles: string[] = ["staff"]): Identity => ({ subjectId: userId ?? "nobody", roles, attributes: userId ? { userId } : {} });
const alice = who("alice");
const bob = who("bob");
const auditor = who("auditor", ["auditor"]);
const mallory = who(undefined);

const EXACT: Record<string, PolicyRule> = {
  "case.read": anyOf(requireRole("auditor"), requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("reviewerId", "userId"))
};
const caseRead = EXACT["case.read"]!;
/** The same decisions, as a plain function: unplannable. */
const OPAQUE: Record<string, PolicyRule> = { "case.read": (r) => caseRead(r) };

async function setup(opts: { rules?: Record<string, PolicyRule>; engine?: PolicyEngine; options?: SemanticRuntimeOptions; protects?: string[]; escalations?: boolean } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Case/1.0.0",
      type: "object",
      title: "Case",
      properties: Object.fromEntries(["id", "ownerId", "reviewerId", "title", "escalatedTo"].map((p) => [p, { type: "string" }])),
      "x-computed": { headline: { dependsOn: ["title"], binding: "headline" } },
      "x-policy": { objectPolicy: "case.read" }
    },
    { name: "test.Case", version: "1.0.0", computedImplementations: { headline: async (ctx) => String(await ctx.getProperty("title")).toUpperCase() } }
  );
  await registry.registerMapping({ id: "map-case", typeName: "test.Case", target: "property", targetName: "*", dataSourceId: "cases", operation: "get", resolutionMode: "live" });
  const cases = new RecordingAdapter("cases", CASES, opts.protects);
  const adapters: Adapter[] = [cases];
  if (opts.escalations) {
    await registry.registerMapping({ id: "map-esc", typeName: "test.Case", target: "property", targetName: "escalatedTo", dataSourceId: "escalations", operation: "get", resolutionMode: "live" });
    adapters.push(new RecordingAdapter("escalations", ESCALATIONS));
  }
  let engine = opts.engine;
  if (!engine) {
    const abac = new AbacPolicyEngine();
    for (const [name, rule] of Object.entries(opts.rules ?? EXACT)) abac.registerRule(name, rule);
    abac.registerRule("public", allowAllRule);
    engine = abac;
  }
  return { runtime: new SemanticRuntime(registry, adapters, engine, opts.options), registry, cases };
}

const ids = (r: { items: { objectId: string }[] }) => r.items.map((i) => i.objectId);
const rows = async (registry: SemanticRegistry) => (await registry.listAuditEvents({ limit: 1000 })).items;
const planRows = async (registry: SemanticRegistry) => (await rows(registry)).filter((e) => e.details?.control === "row-plan");
const count = { type: "test.Case", aggregations: [{ name: "n", op: "count" as const }] };

/** An engine that decides with the exact rules but plans whatever it's told. */
function lyingEngine(plan: (r: PolicyRequest) => Promise<unknown>): PolicyEngine {
  const abac = new AbacPolicyEngine();
  abac.registerRule("case.read", caseRead);
  return { evaluate: (r) => abac.evaluate(r), plan: plan as PolicyEngine["plan"] };
}

describe("authorization planning in the runtime (ADR-0038)", () => {
  describe("query", () => {
    it("pushes the exact plan into the adapter's filter, ANDed with the caller's", async () => {
      const { runtime, cases } = await setup();
      expect(ids(await runtime.query({ type: "test.Case" }, alice))).toEqual(["c1"]);
      expect(cases.queried.at(-1)).toEqual({ or: [{ property: "ownerId", operator: "eq", value: "alice" }, { property: "reviewerId", operator: "eq", value: "alice" }] });
      await runtime.query({ type: "test.Case", filter: { property: "title", operator: "icontains", value: "l" } }, bob);
      expect(cases.queried.at(-1)).toEqual({
        and: [{ property: "title", operator: "icontains", value: "l" }, { or: [{ property: "ownerId", operator: "eq", value: "bob" }, { property: "reviewerId", operator: "eq", value: "bob" }] }]
      });
      // Always: nothing to push. The auditor's query reaches the adapter unfiltered.
      await runtime.query({ type: "test.Case" }, auditor);
      expect(cases.queried.at(-1)).toBeUndefined();
    });

    it("pages are full under an exact plan: the short-page channel closes", async () => {
      const walk = async (runtime: SemanticRuntime) => {
        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await runtime.query({ type: "test.Case", limit: 1, cursor }, bob);
          pages.push(ids(page));
          cursor = page.nextCursor;
        } while (cursor);
        return pages;
      };
      // Bob may read c1, c2, c4, c5. Post-filtered, c3's slot comes back as an empty page with a cursor.
      expect(await walk((await setup({ rules: OPAQUE })).runtime)).toEqual([["c1"], ["c2"], [], ["c4"], ["c5"]]);
      expect(await walk((await setup()).runtime)).toEqual([["c1"], ["c2"], ["c4"], ["c5"]]);
    });

    it("a never plan returns an empty page without calling the adapter, and audits one deny for the Type", async () => {
      const { runtime, registry, cases } = await setup();
      expect(await runtime.query({ type: "test.Case" }, mallory)).toEqual({ items: [] });
      expect(cases.queried).toEqual([]);
      const [row] = await planRows(registry);
      expect(row).toMatchObject({ decision: "deny", resource: { typeName: "test.Case" }, details: { plan: "never", exact: true, limitations: [] } });
      expect(row!.resource.objectId).toBeUndefined();
    });

    it("every object the plan admits is still decided and audited after the read", async () => {
      const { runtime, registry } = await setup();
      await runtime.query({ type: "test.Case" }, bob);
      const decided = (await rows(registry)).filter((e) => e.resource.objectId && !e.details);
      expect(decided.map((e) => [e.resource.objectId, e.decision]).sort()).toEqual([["c1", "allow"], ["c2", "allow"], ["c4", "allow"], ["c5", "allow"]]);
    });

    it("the plan's own attributes aren't probes: they select nothing the policy doesn't already decide on", async () => {
      // Filtering on reviewerId would need the caller to be able to read it; the plan doesn't.
      const { runtime } = await setup();
      expect(ids(await runtime.query({ type: "test.Case", select: ["title"] }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
    });
  });

  describe("aggregate", () => {
    it("applies an exact plan before the adapter aggregates, and audits the type-level deny and the plan's allow", async () => {
      const { runtime, registry, cases } = await setup();
      expect((await runtime.aggregate(count, bob)).groups).toEqual([{ key: {}, values: { n: 4 } }]);
      expect(cases.aggregated.at(-1)).toEqual({ or: [{ property: "ownerId", operator: "eq", value: "bob" }, { property: "reviewerId", operator: "eq", value: "bob" }] });
      const bobRows = (await rows(registry)).filter((e) => e.subjectId === "bob");
      expect(bobRows.map((e) => [e.decision, e.details?.control ?? "policy"]).sort()).toEqual([["allow", "row-plan"], ["deny", "policy"]]);
    });

    it("keeps the caller's own filter, and the type-level allow path unchanged", async () => {
      const { runtime, cases } = await setup();
      const filtered = { ...count, filter: { property: "title", operator: "icontains" as const, value: "light" } };
      expect((await runtime.aggregate(filtered, bob)).groups[0]!.values.n).toBe(1);
      expect((await runtime.aggregate(count, auditor)).groups[0]!.values.n).toBe(5);
      expect(cases.aggregated.at(-1)).toBeUndefined();
    });

    it("attack: anything short of exact still refuses — unknown, never, weakened, or a failed planner", async () => {
      for (const world of [
        await setup({ rules: OPAQUE }),
        await setup({ protects: ["ownerId"] }),
        await setup({ engine: lyingEngine(() => Promise.reject(new Error("down"))) }),
        await setup({ engine: { evaluate: (r) => caseRead(r) as never } })
      ]) {
        await expect(world.runtime.aggregate(count, bob)).rejects.toBeInstanceOf(AuthorizationError);
        expect(world.cases.aggregated).toEqual([]);
      }
      const { runtime, cases } = await setup();
      await expect(runtime.aggregate(count, mallory)).rejects.toBeInstanceOf(AuthorizationError);
      expect(cases.aggregated).toEqual([]);
    });
  });

  describe("an inexact predicate — narrowing, but not the policy", () => {
    // allOf(opaque, owner): the owner atom narrows the read; the opaque half keeps it from being exact.
    const opaqueAnd = { "case.read": allOf((r) => ({ allow: r.resource.attributes?.title !== "Broken badge" }), requireAttributeMatch("ownerId", "userId")) };

    it("is still pushed down, and the post-read check decides the rest", async () => {
      const { runtime, cases } = await setup({ rules: opaqueAnd });
      expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c4"]);
      expect(cases.queried.at(-1)).toEqual({ property: "ownerId", operator: "eq", value: "bob" });
      expect((await runtime.explainQuery({ type: "test.Case" }, bob)).guarantees).toMatchObject({ exact: false, aggregationSafe: false, postFilterRequired: true });
    });

    it("attack: can't aggregate — it would count c2, which bob can't read — and require-exact refuses it", async () => {
      const { runtime, cases } = await setup({ rules: opaqueAnd });
      await expect(runtime.aggregate(count, bob)).rejects.toBeInstanceOf(AuthorizationError);
      expect(cases.aggregated).toEqual([]);
      const strict = await setup({ rules: opaqueAnd, options: { rowSecurity: "require-exact" } });
      await expect(strict.runtime.query({ type: "test.Case" }, bob)).rejects.toBeInstanceOf(AuthorizationPlanError);
    });
  });

  describe("fitting a plan to where the data is", () => {
    it("an attribute the adapter protects is weakened to true — the rows it alone admits still come back", async () => {
      // Bob reads c5 only as its reviewer. With reviewerId protected, that disjunct becomes `true`:
      // replaced, not dropped, so c5 is still read and decided.
      const { runtime, cases } = await setup({ protects: ["reviewerId"] });
      expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
      expect(cases.queried.at(-1)).toBeUndefined(); // or(ownerId = bob, true) = true
      expect((await runtime.explainQuery({ type: "test.Case" }, bob)).plan).toEqual({ kind: "unknown", limitations: [{ code: "protected-attribute", attribute: "reviewerId" }] });
    });

    it("attack: a decorator that makes the declaration async, answers junk, or throws can't un-protect an attribute", async () => {
      for (const declare of [async () => ["reviewerId"], () => "reviewerId", () => [7], () => {
        throw new Error("down");
      }]) {
        const { runtime, cases } = await setup();
        Object.assign(cases, { sensitiveFields: declare });
        expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
        expect(cases.queried.at(-1)).toBeUndefined(); // never an authorization filter on a protected attribute
        expect(isExact((await runtime.explainQuery({ type: "test.Case" }, bob)).plan)).toBe(false);
      }
    });

    it("an adapter that says it can filter a protected attribute gets it pushed — exactly (ADR-0040)", async () => {
      const { runtime, cases } = await setup({ protects: ["reviewerId"] });
      Object.assign(cases, { canFilter: async (_t: string, property: string, op: string) => op === "eq" && property === "reviewerId" });
      expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
      // ownerId isn't protected, but the adapter answers for every field: it said no.
      expect((await runtime.explainQuery({ type: "test.Case" }, bob)).plan).toEqual({ kind: "unknown", limitations: [{ code: "unfilterable-attribute", attribute: "ownerId" }] });
      Object.assign(cases, { canFilter: () => true });
      await runtime.query({ type: "test.Case" }, bob);
      expect(cases.queried.at(-1)).toEqual({ or: [{ property: "ownerId", operator: "eq", value: "bob" }, { property: "reviewerId", operator: "eq", value: "bob" }] });
      expect(isExact((await runtime.explainQuery({ type: "test.Case" }, bob)).plan)).toBe(true);
    });

    it("attack: a capability answer that isn't exactly true — junk, a truthy string, a throw — never pushes", async () => {
      for (const canFilter of [() => "yes", () => 1, async () => ({}), () => {
        throw new Error("down");
      }]) {
        const { runtime, cases } = await setup();
        Object.assign(cases, { canFilter });
        expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
        expect(cases.queried.at(-1)).toBeUndefined();
      }
    });

    it("an attribute from another data source is weakened too, and the merged value still decides", async () => {
      const rules = { "case.read": anyOf(requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("escalatedTo", "userId")) };
      const { runtime, cases } = await setup({ rules, escalations: true });
      // alice owns c1 and c3 is escalated to her — a value only the escalations source holds.
      expect(ids(await runtime.query({ type: "test.Case" }, alice))).toEqual(["c1", "c3"]);
      expect(cases.queried.at(-1)).toBeUndefined();
      expect((await runtime.explainQuery({ type: "test.Case" }, alice)).plan).toEqual({ kind: "unknown", limitations: [{ code: "cross-source-attribute", attribute: "escalatedTo" }] });
    });

    it("an AND keeps narrowing past a weakened atom, inexactly", async () => {
      const rules = { "case.read": allOf(requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("reviewerId", "userId")) };
      const { runtime, cases } = await setup({ rules, protects: ["reviewerId"] });
      await setup({ rules }).then(async (plain) => expect(ids(await plain.runtime.query({ type: "test.Case" }, bob))).toEqual([]));
      expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual([]);
      // and(ownerId = bob, true): still pushed, no longer exact.
      expect(cases.queried.at(-1)).toEqual({ property: "ownerId", operator: "eq", value: "bob" });
      expect((await runtime.explainQuery({ type: "test.Case" }, bob)).plan).toEqual({
        kind: "predicate",
        predicate: { attribute: "ownerId", eq: "bob" },
        exact: false,
        limitations: [{ code: "protected-attribute", attribute: "reviewerId" }]
      });
    });
  });

  describe("planner defects", () => {
    it("a planner that throws, returns junk, or overclaims exactness falls back to unknown under post-filter", async () => {
      for (const plan of [
        () => Promise.reject(new Error("down")),
        async () => ({ kind: "sometimes" }),
        async () => ({ kind: "predicate", predicate: { attribute: "ownerId", eq: "bob" }, exact: true, limitations: [{ code: "opaque-rule", policyName: "x" }] })
      ]) {
        const { runtime, cases } = await setup({ engine: lyingEngine(plan) });
        expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
        expect(cases.queried.at(-1)).toBeUndefined();
        expect((await runtime.explainQuery({ type: "test.Case" }, bob)).plan).toEqual({ kind: "unknown", limitations: [{ code: "planner-failed", policyName: "case.read" }] });
      }
    });

    it("an exact plan that admits an object the policy denies is caught after the read: audited, counted, and dropped", async () => {
      const { runtime, registry } = await setup({ engine: lyingEngine(async () => ALWAYS) });
      expect(ids(await runtime.query({ type: "test.Case" }, alice))).toEqual(["c1"]);
      const defects = (await planRows(registry)).filter((e) => e.details?.defect === "admitted-denied");
      expect(defects.map((e) => e.resource.objectId).sort()).toEqual(["c2", "c3", "c4", "c5"]);
      expect(defects.every((e) => e.decision === "deny")).toBe(true);
    });

    it("pinned: a plan that admits too little hides authorized rows, and nothing at runtime can notice — only the conformance check can", async () => {
      const { runtime } = await setup({ engine: lyingEngine(async () => NEVER) });
      expect(ids(await runtime.query({ type: "test.Case" }, alice))).toEqual([]);
    });
  });

  describe('rowSecurity: "require-exact"', () => {
    const strict = { options: { rowSecurity: "require-exact" } as SemanticRuntimeOptions };

    it("an exact plan — predicate, always, or never — runs as under post-filter", async () => {
      const { runtime } = await setup(strict);
      expect(ids(await runtime.query({ type: "test.Case" }, bob))).toEqual(["c1", "c2", "c4", "c5"]);
      expect(ids(await runtime.query({ type: "test.Case" }, auditor))).toHaveLength(5);
      expect(await runtime.query({ type: "test.Case" }, mallory)).toEqual({ items: [] });
    });

    it("attack: an inexact plan is refused — opaque rule, no planner, failed planner, weakened attribute — and audited", async () => {
      for (const world of [
        await setup({ ...strict, rules: OPAQUE }),
        await setup({ ...strict, engine: { evaluate: (r) => caseRead(r) as never } }),
        await setup({ ...strict, engine: lyingEngine(() => Promise.reject(new Error("down"))) }),
        await setup({ ...strict, protects: ["reviewerId"] })
      ]) {
        await expect(world.runtime.query({ type: "test.Case" }, bob)).rejects.toBeInstanceOf(AuthorizationPlanError);
        expect(world.cases.queried).toEqual([]);
        const [row] = await planRows(world.registry);
        expect(row).toMatchObject({ decision: "deny", details: { exact: false } });
      }
    });

    it("a detected defect fails the query", async () => {
      const { runtime } = await setup({ ...strict, engine: lyingEngine(async () => ALWAYS) });
      await expect(runtime.query({ type: "test.Case" }, alice)).rejects.toThrow(/exact authorization plan admitted an object the policy denies/);
    });

    it("the error names the policy and limitation codes, never an attribute value", async () => {
      const { runtime } = await setup({ ...strict, protects: ["reviewerId"] });
      const err = (await runtime.query({ type: "test.Case" }, bob).catch((e: unknown) => e)) as AuthorizationPlanError;
      expect(err.message).toContain('policy "case.read"');
      expect(err.message).toContain("protected-attribute");
      expect(err.message).not.toMatch(/bob/);
    });

    it("an unrecognized setting is refused at construction", async () => {
      await expect(setup({ options: { rowSecurity: "strict" as never } })).rejects.toThrow(/rowSecurity/);
    });
  });

  describe("explainQuery", () => {
    it("reports the fitted plan and the guarantees that follow, without reading any data", async () => {
      const { runtime, cases } = await setup();
      const report = await runtime.explainQuery({ type: "test.Case" }, bob);
      expect(report).toEqual({
        typeName: "test.Case",
        policyName: "case.read",
        securityProfile: null,
        rowSecurity: "post-filter",
        plan: { kind: "predicate", exact: true, limitations: [], predicate: { or: [{ attribute: "ownerId", eq: "bob" }, { attribute: "reviewerId", eq: "bob" }] } },
        probes: [],
        guarantees: { exact: true, paginationPrivate: true, aggregationSafe: true, postFilterRequired: false }
      });
      expect(cases.queried).toEqual([]);
    });

    it("a probe costs pagination privacy — a value's own marking can still drop a row — but not exactness", async () => {
      const { runtime } = await setup();
      const report = await runtime.explainQuery({ type: "test.Case", filter: { property: "title", operator: "eq", value: "x" }, sort: [{ property: "ownerId" }], search: { text: "l" } }, bob);
      expect(report.probes.sort()).toEqual(["escalatedTo", "id", "ownerId", "reviewerId", "title"]);
      expect(report.guarantees).toEqual({ exact: true, paginationPrivate: false, aggregationSafe: true, postFilterRequired: false });
    });

    it("says what an inexact or empty plan does and doesn't guarantee", async () => {
      const opaque = await (await setup({ rules: OPAQUE })).runtime.explainQuery({ type: "test.Case" }, bob);
      expect(opaque.guarantees).toEqual({ exact: false, paginationPrivate: false, aggregationSafe: false, postFilterRequired: true });
      expect(opaque.plan).toEqual({ kind: "unknown", limitations: [{ code: "opaque-rule", policyName: "case.read" }] });
      const never = await (await setup()).runtime.explainQuery({ type: "test.Case" }, mallory);
      expect(never.guarantees).toEqual({ exact: true, paginationPrivate: true, aggregationSafe: false, postFilterRequired: false });
    });

    it("is audited with the plan's kind, exactness, and limitation codes — no literals, no identity values", async () => {
      const { runtime, registry } = await setup({ protects: ["reviewerId"] });
      await runtime.explainQuery({ type: "test.Case" }, bob);
      const [row] = await planRows(registry);
      expect(row!.details).toEqual({ control: "row-plan", operation: "explainQuery", plan: "unknown", exact: false, limitations: ["protected-attribute"] });
      const exact = await setup();
      await exact.runtime.explainQuery({ type: "test.Case" }, bob);
      await exact.runtime.query({ type: "test.Case" }, bob);
      await exact.runtime.aggregate(count, bob);
      for (const r of await planRows(exact.registry)) expect(JSON.stringify(r.details)).not.toMatch(/bob|alice|ownerId|reviewerId/);
    });
  });
});
