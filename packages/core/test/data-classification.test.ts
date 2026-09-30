import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort, computeAggregations } from "../src/runtime/query-ops.js";
import { parseResolution } from "../src/runtime/resolution.js";
import { DEMO_LINEAR_CLASSIFICATION, linearClassification, type ClassificationScheme } from "../src/runtime/classification.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { AggregateResult, QueryFilter, SemanticAggregateQuery, SortKey } from "../src/model/query.js";
import type { Identity, PolicyEngine } from "../src/model/policy.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";
import type { AuditEvent } from "../src/audit/audit-log.js";

/**
 * Data classification enforcement, ADR-0032. Object policies here allow
 * everyone, so every denial below is classification's alone — except where a
 * property policy is added on purpose to show the two controls compose.
 *
 * - `test.Report` is unmarked as a Type, with members marked at every level,
 *   computed properties derived from them, and a TOP_SECRET relationship.
 * - `test.Annex` is a SECRET Type (object classification).
 * - `test.Notice` is unmarked in the schema; the adapter marks individual
 *   *values* through their provenance.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Report": {
    r1: { id: "r1", title: "Harbor survey", region: "north", summary: "Two frigates sighted", sourceName: "ASSET-KESTREL", analystNotes: "Corroborate via SIGINT", pages: 12 },
    r2: { id: "r2", title: "Rail audit", region: "south", summary: "Bridge weakened", sourceName: "ASSET-HERON", analystNotes: "Low confidence", pages: 30 }
  },
  "test.Annex": { a1: { id: "a1", reportId: "r1", body: "Annex A body" } },
  "test.Source": { s1: { id: "s1", reportId: "r1", handle: "KESTREL" } },
  "test.Notice": {
    n1: { id: "n1", title: "Notice one", location: "Grid 38SMB" },
    n2: { id: "n2", title: "Notice two", location: "Main gate" },
    n3: { id: "n3", title: "Notice three", location: "Grid 38SMC" }
  }
};
/** Value-level markings the adapter reports in provenance: `type/id/field` → marking. */
const VALUE_MARKINGS: Record<string, string> = { "test.Notice/n1/location": "SECRET", "test.Notice/n3/location": "TOP_SECRET" };

/** Every classified value in the fixture: none may reach a caller who isn't cleared for it. */
const SECRET_VALUES = ["Two frigates sighted", "Bridge weakened", "Corroborate via SIGINT", "Low confidence", "TWO FRIGATES", "Grid 38SMB", "Annex A body"];
const TOP_SECRET_VALUES = ["ASSET-KESTREL", "ASSET-HERON", "KESTREL", "Grid 38SMC"];

class MarkedAdapter implements Adapter {
  readonly dataSourceId = "marked-ds";
  readonly reads: string[] = [];
  readonly actions: unknown[] = [];

  private prov(typeName: string, objectId: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => {
      const classification = VALUE_MARKINGS[`${typeName}/${objectId}/${field}`];
      return {
        propertyPath: field,
        source: { dataSourceId: this.dataSourceId, system: "marked", recordId: objectId, field },
        retrievedAt: "2026-01-01T00:00:00.000Z",
        ...(classification ? { classification } : {})
      };
    });
  }
  private rows(typeName: string) {
    this.reads.push(typeName);
    return Object.entries(DATA[typeName] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(typeName, objectId, values) }));
  }
  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.reads.push(typeName);
    const values = DATA[typeName]?.[objectId] ?? {};
    return { values: { ...values }, provenance: this.prov(typeName, objectId, values) };
  }
  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    const sorted = applySort(this.rows(typeName).filter((r) => matchesFilter(r.values, filter)), sort, (r) => r.values);
    const start = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(start, start + (limit ?? sorted.length)) };
  }
  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind !== "byForeignKey") throw new Error("unsupported");
    return Object.entries(DATA[relationship.targetType] ?? {})
      .filter(([, v]) => v[strategy.field] === sourceObjectId)
      .map(([objectId]) => ({ objectId }));
  }
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    return computeAggregations(this.rows(query.type).map((r) => r.values).filter((v) => matchesFilter(v, query.filter)), query);
  }
  async executeAction(_action: unknown, input: unknown): Promise<unknown> {
    this.actions.push(input);
    return { ...DATA["test.Annex"]!.a1 };
  }
}

const reader = (subjectId: string, clearance?: string, roles: string[] = ["reader"]): Identity => ({ subjectId, roles, attributes: {}, ...(clearance !== undefined ? { clearance } : {}) });
const uncleared = reader("uncleared");
const cui = reader("cui", "CUI");
const secret = reader("secret", "SECRET");
const topSecret = reader("ts", "TOP_SECRET");
const secretAnalyst = reader("secret-analyst", "SECRET", ["reader", "analyst"]);
const cuiAnalyst = reader("cui-analyst", "CUI", ["reader", "analyst"]);

async function registerType(registry: SemanticRegistry, name: string, schema: Omit<SemanticTypeSchema, "$id" | "type">) {
  const short = name.split(".")[1]!;
  await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, {
    name,
    version: "1.0.0",
    computedImplementations: {
      briefing: async (ctx) => String(await ctx.getProperty("summary")).toUpperCase(),
      briefingLength: async (ctx) => String(await ctx.getProperty("briefing")).length,
      headline: async (ctx) => `${String(await ctx.getProperty("title"))}!`,
      notesDigest: async (ctx) => String(await ctx.getProperty("analystNotes")).slice(0, 4)
    }
  });
  await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "marked-ds", operation: "get", resolutionMode: "live" });
}

const strings = (names: string[]) => Object.fromEntries(names.map((n) => [n, { type: "string" }]));

async function setup(opts: { policyEngine?: PolicyEngine; classification?: ClassificationScheme } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerType(registry, "test.Annex", {
    title: "Annex",
    properties: strings(["id", "reportId", "body"]),
    "x-policy": { objectPolicy: "public" },
    "x-provenance": { defaultClassification: "SECRET" }
  });
  await registerType(registry, "test.Source", { title: "Source", properties: strings(["id", "reportId", "handle"]), "x-policy": { objectPolicy: "public" } });
  await registerType(registry, "test.Report", {
    title: "Report",
    properties: { ...strings(["id", "title", "region", "summary", "sourceName", "analystNotes"]), pages: { type: "number" } },
    "x-relationships": {
      annexes: { target: "test.Annex", cardinality: "one-to-many", resolution: { dataSourceId: "marked-ds", operation: "byForeignKey:reportId" } },
      sources: { target: "test.Source", cardinality: "one-to-many", resolution: { dataSourceId: "marked-ds", operation: "byForeignKey:reportId" } }
    },
    "x-computed": {
      briefing: { dependsOn: ["summary"], binding: "briefing" },
      briefingLength: { dependsOn: ["briefing"], binding: "briefingLength" },
      headline: { dependsOn: ["title"], binding: "headline" },
      notesDigest: { dependsOn: ["analystNotes"], binding: "notesDigest" }
    },
    "x-actions": { actions: ["FileAnnex"] },
    "x-policy": { objectPolicy: "public", propertyPolicies: { analystNotes: "analysts-only" } },
    "x-provenance": {
      properties: {
        summary: { classification: "SECRET" },
        pages: { classification: "SECRET" },
        sourceName: { classification: "TOP_SECRET" },
        analystNotes: { classification: "SECRET" },
        sources: { classification: "TOP_SECRET" },
        region: { classification: "UNCLASSIFIED" }
      }
    }
  });
  await registerType(registry, "test.Notice", { title: "Notice", properties: strings(["id", "title", "location"]), "x-policy": { objectPolicy: "public" } });
  // FileAnnex and SealAnnex act on the SECRET Annex (one open to all, one analysts-only); PinNotice on the unmarked Notice.
  for (const [name, applicableType, authorizationPolicy] of [
    ["FileAnnex", "test.Annex", "public"],
    ["SealAnnex", "test.Annex", "analysts-only"],
    ["PinNotice", "test.Notice", "public"]
  ] as const) {
    await registry.registerAction({
      id: `action-${name}`,
      name,
      description: `${name}.`,
      applicableTypes: [applicableType],
      inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] },
      outputSchema: { type: "object" },
      authorizationPolicy,
      implementation: { dataSourceId: "marked-ds", operation: name },
      sideEffects: "creates",
      idempotency: "none",
      auditRequired: true,
      version: "1.0.0"
    });
  }

  let policyEngine = opts.policyEngine;
  if (!policyEngine) {
    const abac = new AbacPolicyEngine();
    abac.registerRule("public", allowAllRule);
    abac.registerRule("analysts-only", requireRole("analyst"));
    policyEngine = abac;
  }
  const adapter = new MarkedAdapter();
  // The fixture's markings are in the demo vocabulary, so it configures that scheme explicitly (ADR-0034).
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { classification: opts.classification ?? DEMO_LINEAR_CLASSIFICATION });
  return { runtime, registry, adapter };
}

const keys = (o: { values: Record<string, unknown> }) => Object.keys(o.values).sort();
const ids = (objs: unknown) => (objs as { objectId: string }[]).map((o) => o.objectId).sort();
const classificationRows = async (registry: SemanticRegistry): Promise<AuditEvent[]> =>
  (await registry.listAuditEvents({ limit: 5000 })).items.filter((e) => e.details?.control === "classification");

describe("Data classification (ADR-0032)", () => {
  describe("the scheme", () => {
    it("DEMO_LINEAR_CLASSIFICATION orders UNCLASSIFIED < CUI < SECRET < TOP_SECRET, and exposes that order", () => {
      const levels = ["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"];
      for (const [i, clearance] of levels.entries()) {
        for (const [j, marking] of levels.entries()) expect(DEMO_LINEAR_CLASSIFICATION.dominates(clearance, marking)).toBe(i >= j);
      }
      expect(DEMO_LINEAR_CLASSIFICATION.levels).toEqual(levels);
      expect(Object.isFrozen(DEMO_LINEAR_CLASSIFICATION.levels)).toBe(true);
    });

    it("fails closed: a missing or unknown clearance holds only the lowest level, and an unknown marking is readable by no one", () => {
      for (const clearance of [undefined, "ULTRA", "secret", "", "TOP SECRET"]) {
        expect(DEMO_LINEAR_CLASSIFICATION.dominates(clearance, "UNCLASSIFIED")).toBe(true);
        expect(DEMO_LINEAR_CLASSIFICATION.dominates(clearance, "CUI")).toBe(false);
      }
      for (const marking of ["SECERT", "secret", "", "__proto__", "constructor"]) expect(DEMO_LINEAR_CLASSIFICATION.dominates("TOP_SECRET", marking)).toBe(false);
    });

    it("refuses an empty or ambiguous ordering", () => {
      expect(() => linearClassification([])).toThrow(TypeError);
      expect(() => linearClassification(["LOW", "HIGH", "LOW"])).toThrow(TypeError);
    });
  });

  describe("objects", () => {
    it("a classified object is readable only with clearance, and denied with a reason that names no marking", async () => {
      const { runtime } = await setup();
      await expect(runtime.getObject("test.Annex", "a1", secret)).resolves.toMatchObject({ values: { body: "Annex A body" } });
      const err = (await runtime.getObject("test.Annex", "a1", cui).then(
        () => undefined,
        (e: unknown) => e
      )) as AuthorizationError;
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(err.reason).toBe("Requires a higher clearance");
      expect(`${err.message} ${err.reason}`).not.toMatch(/SECRET|CUI/);
    });

    it("an uncleared caller never causes a classified object to be read — getObject or query", async () => {
      const { runtime, adapter } = await setup();
      await expect(runtime.getObject("test.Annex", "a1", uncleared)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.query({ type: "test.Annex" }, cui)).resolves.toEqual({ items: [] });
      expect(adapter.reads).not.toContain("test.Annex");
      expect(ids((await runtime.query({ type: "test.Annex" }, secret)).items)).toEqual(["a1"]);
    });

    it("a classified related object is dropped from a relationship, and a classified relationship is refused", async () => {
      const { runtime } = await setup();
      expect(await runtime.getRelationship("test.Report", "r1", "annexes", cui)).toEqual([]);
      expect(ids(await runtime.getRelationship("test.Report", "r1", "annexes", secret))).toEqual(["a1"]);
      await expect(runtime.getRelationship("test.Report", "r1", "sources", secret)).rejects.toBeInstanceOf(AuthorizationError);
      expect(ids(await runtime.getRelationship("test.Report", "r1", "sources", topSecret))).toEqual(["s1"]);
    });
  });

  describe("values", () => {
    it("redacts each property marked above the caller's clearance", async () => {
      const { runtime } = await setup();
      const base = ["headline", "id", "region", "title"];
      expect(keys(await runtime.getObject("test.Report", "r1", uncleared))).toEqual(base);
      expect(keys(await runtime.getObject("test.Report", "r1", cui))).toEqual(base);
      // notesDigest derives from the SECRET, analysts-only analystNotes: classification follows the derivation, the
      // policy deliberately doesn't (a policy author gates a computed property explicitly), so a SECRET reader sees it.
      expect(keys(await runtime.getObject("test.Report", "r1", secret))).toEqual([...base, "briefing", "briefingLength", "notesDigest", "pages", "summary"].sort());
      expect(keys(await runtime.getObject("test.Report", "r1", topSecret))).toEqual(
        [...base, "briefing", "briefingLength", "notesDigest", "pages", "sourceName", "summary"].sort()
      );
    });

    it("honors a value's own provenance marking, where the schema marks nothing", async () => {
      const { runtime } = await setup();
      const asCui = await runtime.query({ type: "test.Notice" }, cui);
      expect(Object.fromEntries(asCui.items.map((i) => [i.objectId, i.values.location]))).toEqual({ n1: undefined, n2: "Main gate", n3: undefined });
      const asSecret = await runtime.query({ type: "test.Notice" }, secret);
      expect(Object.fromEntries(asSecret.items.map((i) => [i.objectId, i.values.location]))).toEqual({ n1: "Grid 38SMB", n2: "Main gate", n3: undefined });
    });

    it("derived data inherits its inputs' classification, transitively", async () => {
      const { runtime } = await setup();
      const asCui = await runtime.getObject("test.Report", "r1", cui);
      expect(asCui.values).not.toHaveProperty("briefing"); // from SECRET summary
      expect(asCui.values).not.toHaveProperty("briefingLength"); // from briefing, from summary
      expect(asCui.values.headline).toBe("Harbor survey!"); // from an unmarked title
      expect((await runtime.getObject("test.Report", "r1", secret)).values.briefingLength).toBe(20);
    });

    it("a derivation can't launder a marking because its source was already hidden by a policy", async () => {
      const { runtime } = await setup();
      // analystNotes is SECRET *and* analysts-only. For a CUI non-analyst the policy hides it first — yet the digest
      // derived from it must still be classified out, so markings are decided before any policy removes a value.
      const asCui = await runtime.getObject("test.Report", "r1", cui);
      expect(asCui.values).not.toHaveProperty("analystNotes");
      expect(asCui.values).not.toHaveProperty("notesDigest");
      expect((await runtime.getObject("test.Report", "r1", cuiAnalyst)).values).not.toHaveProperty("notesDigest");
      expect((await runtime.getObject("test.Report", "r1", secretAnalyst)).values.notesDigest).toBe("Corr");
    });
  });

  describe("orthogonal to policy: both must pass, either can hide", () => {
    it("a property needs both its policy and its clearance", async () => {
      const { runtime } = await setup();
      expect((await runtime.getObject("test.Report", "r1", secretAnalyst)).values.analystNotes).toBe("Corroborate via SIGINT");
      expect((await runtime.getObject("test.Report", "r1", secret)).values).not.toHaveProperty("analystNotes"); // policy hides
      expect((await runtime.getObject("test.Report", "r1", cuiAnalyst)).values).not.toHaveProperty("analystNotes"); // classification hides
    });

    it("no policy engine can relax it — not even one that allows everything", async () => {
      const permissive: PolicyEngine = { evaluate: async () => ({ allow: true }) };
      const { runtime } = await setup({ policyEngine: permissive });
      const read = await runtime.getObject("test.Report", "r1", cui);
      for (const hidden of ["summary", "sourceName", "analystNotes", "briefing"]) expect(read.values).not.toHaveProperty(hidden);
      await expect(runtime.getObject("test.Annex", "a1", cui)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });

  describe("attack: reading a classified value or object through every path", () => {
    it("cannot via query projection, includes, or provenance on the read", async () => {
      const { runtime } = await setup();
      const q = await runtime.query(
        { type: "test.Report", select: ["summary", "sourceName", "briefing", "title"], includeProvenance: true, include: [{ relationship: "annexes" }] },
        cui
      );
      for (const item of q.items) {
        expect(Object.keys(item.values).sort()).toEqual(["annexes", "title"]);
        expect(item.values.annexes).toEqual([]);
        expect((item.provenance ?? []).map((p) => p.propertyPath)).toEqual(["title"]);
      }
      const read = await runtime.getObject("test.Report", "r1", cui, { includeProvenance: true });
      expect((read.provenance ?? []).map((p) => p.propertyPath).sort()).toEqual(["id", "region", "title"]);
    });

    it("cannot via getProvenance — declared, value-level, or derived", async () => {
      const { runtime } = await setup();
      await expect(runtime.getProvenance("test.Report", "r1", "summary", cui)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Report", "r1", "briefing", cui)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Report", "r1", "briefingLength", cui)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Notice", "n1", "location", cui)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Annex", "a1", "body", cui)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Notice", "n2", "location", cui)).resolves.toHaveLength(1);
      await expect(runtime.getProvenance("test.Notice", "n1", "location", secret)).resolves.toMatchObject([{ classification: "SECRET" }]);
    });

    it("cannot probe a declared marking through a filter, sort, search, or aggregation", async () => {
      const { runtime } = await setup();
      const probes = [
        runtime.query({ type: "test.Report", filter: { property: "summary", operator: "eq", value: "Two frigates sighted" } }, cui),
        runtime.query({ type: "test.Report", sort: [{ property: "sourceName", direction: "asc" }] }, secret),
        runtime.query({ type: "test.Report", search: { text: "frigates", properties: ["summary"] } }, cui),
        runtime.aggregate({ type: "test.Report", groupBy: ["summary"], aggregations: [{ name: "n", op: "count" }] }, cui),
        runtime.aggregate({ type: "test.Report", aggregations: [{ name: "total", op: "sum", property: "pages" }] }, cui),
        runtime.aggregate({ type: "test.Annex", aggregations: [{ name: "n", op: "count" }] }, cui)
      ];
      for (const probe of probes) await expect(probe).rejects.toBeInstanceOf(AuthorizationError);
      // Default search never ranges over a property marked above the caller: nothing matches the SECRET summary.
      expect((await runtime.query({ type: "test.Report", search: { text: "frigates" } }, cui)).items).toEqual([]);
      expect(ids((await runtime.query({ type: "test.Report", search: { text: "frigates" } }, secret)).items)).toEqual(["r1"]);
    });

    it("cannot probe a value-level marking: an item selected or ordered by a classified-out value is dropped", async () => {
      const { runtime } = await setup();
      const byLocation = (identity: Identity) =>
        runtime.query({ type: "test.Notice", filter: { property: "location", operator: "eq", value: "Grid 38SMB" } }, identity);
      expect((await byLocation(cui)).items).toEqual([]);
      expect(ids((await byLocation(secret)).items)).toEqual(["n1"]);
      expect(ids((await runtime.query({ type: "test.Notice", sort: [{ property: "location", direction: "asc" }] }, cui)).items)).toEqual(["n2"]);
      expect(ids((await runtime.query({ type: "test.Notice", search: { text: "grid" } }, cui)).items)).toEqual([]);
      // A default search is an OR over every searchable field, location included. Which disjunct matched can't be
      // told apart without the hidden value, so an item whose location is classified out is dropped even though its
      // title matched — fail closed. Marking location in the schema instead keeps it out of the search entirely.
      expect(ids((await runtime.query({ type: "test.Notice", search: { text: "notice" } }, cui)).items)).toEqual(["n2"]);
      expect(ids((await runtime.query({ type: "test.Notice", search: { text: "notice", properties: ["title"] } }, cui)).items)).toEqual(["n1", "n2", "n3"]);
    });

    it("cannot via an Action on a classified Type, which listActions reports as unauthorized", async () => {
      const { runtime, adapter } = await setup();
      await expect(runtime.invokeAction("FileAnnex", { reportId: "r1" }, cui)).rejects.toBeInstanceOf(AuthorizationError);
      expect(adapter.actions).toEqual([]);
      const authorized = async (who: Identity) => Object.fromEntries((await runtime.listActions("test.Annex", who)).map((a) => [a.action.name, a.authorized]));
      expect(await authorized(cui)).toEqual({ FileAnnex: false, SealAnnex: false });
      expect(await authorized(secret)).toEqual({ FileAnnex: true, SealAnnex: false });
      await expect(runtime.invokeAction("FileAnnex", { reportId: "r1" }, secret)).resolves.toMatchObject({ id: "a1" });
    });

    it("no classified value reaches an uncleared caller by any path, nor its marking any error", async () => {
      const { runtime } = await setup();
      const surfaced: unknown[] = [];
      const capture = async (p: Promise<unknown>) => surfaced.push(await p.catch((e: unknown) => ({ message: (e as Error).message, reason: (e as AuthorizationError).reason })));
      for (const who of [uncleared, cui, secret]) {
        await capture(runtime.getObject("test.Report", "r1", who, { includeProvenance: true }));
        await capture(runtime.getObject("test.Annex", "a1", who));
        await capture(runtime.query({ type: "test.Report", includeProvenance: true, include: [{ relationship: "annexes" }] }, who));
        await capture(runtime.query({ type: "test.Notice", includeProvenance: true }, who));
        await capture(runtime.getRelationship("test.Report", "r1", "sources", who));
        await capture(runtime.getProvenance("test.Report", "r1", "sourceName", who));
        await capture(runtime.getProvenance("test.Notice", "n3", "location", who));
      }
      const text = JSON.stringify(surfaced);
      for (const v of TOP_SECRET_VALUES) expect(text).not.toContain(v);
      expect(text).not.toContain("TOP_SECRET");

      const lowSurfaced = JSON.stringify(surfaced.slice(0, 14)); // the uncleared and CUI callers' reads
      for (const v of SECRET_VALUES) expect(lowSurfaced).not.toContain(v);
      expect(lowSurfaced).not.toMatch(/"SECRET"|classification/);
    });
  });

  describe("audit", () => {
    it("every classification decision on marked data is audited, allow and deny, and unmarked data writes none", async () => {
      const { runtime, registry } = await setup();
      await runtime.getObject("test.Report", "r1", cui);
      const rows = await classificationRows(registry);
      const byProperty = Object.fromEntries(rows.map((e): [string, string] => [e.resource.propertyPath ?? "(object)", e.decision]));
      expect(byProperty).toEqual({
        region: "allow",
        summary: "deny",
        sourceName: "deny",
        analystNotes: "deny",
        pages: "deny",
        briefing: "deny",
        briefingLength: "deny",
        notesDigest: "deny"
      });
      expect(rows.find((e) => e.resource.propertyPath === "briefing")?.details).toEqual({
        control: "classification",
        scheme: "demo-linear",
        markings: ["SECRET"],
        clearance: "CUI"
      });

      await runtime.getObject("test.Notice", "n2", cui);
      expect((await classificationRows(registry)).filter((e) => e.resource.typeName === "test.Notice")).toEqual([]);
    });

    it("a denied classified object is audited once, before any read", async () => {
      const { runtime, registry } = await setup();
      await runtime.getObject("test.Annex", "a1", cui).catch(() => undefined);
      await runtime.query({ type: "test.Annex" }, cui);
      const rows = (await classificationRows(registry)).filter((e) => e.resource.typeName === "test.Annex");
      expect(rows.map((e) => [e.resource.objectId ?? "(type)", e.decision])).toEqual([
        ["(type)", "deny"],
        ["a1", "deny"]
      ]);
    });
  });

  describe("listActions audits every decision it reports", () => {
    /** The audit rows `run` writes, oldest first, as comparable tuples: what was decided, by which control, and why. */
    async function rowsWrittenBy(registry: SemanticRegistry, run: () => Promise<unknown>) {
      const before = (await registry.listAuditEvents({ limit: 100_000 })).items.length;
      await run().catch(() => undefined);
      const all = (await registry.listAuditEvents({ limit: 100_000 })).items;
      return all
        .slice(0, all.length - before)
        .reverse()
        .filter((e) => e.outcome === undefined) // an executed Action's outcome row is not a decision
        .map((e) => [e.subjectId, e.action, e.resource.typeName, e.details?.control ?? "policy", e.decision, e.reason ?? null]);
    }

    it("writes the policy row and the classification row for each Action on a marked Type — allow and deny", async () => {
      const { runtime, registry } = await setup();
      const listed = (who: Identity) => rowsWrittenBy(registry, () => runtime.listActions("test.Annex", who));

      expect(await listed(secretAnalyst)).toEqual([
        ["secret-analyst", "FileAnnex", "test.Annex", "policy", "allow", null],
        ["secret-analyst", "FileAnnex", "test.Annex", "classification", "allow", null],
        ["secret-analyst", "SealAnnex", "test.Annex", "policy", "allow", null],
        ["secret-analyst", "SealAnnex", "test.Annex", "classification", "allow", null]
      ]);
      // Policy denies SealAnnex, so — exactly as invokeAction would — its clearance is never asked.
      expect(await listed(secret)).toEqual([
        ["secret", "FileAnnex", "test.Annex", "policy", "allow", null],
        ["secret", "FileAnnex", "test.Annex", "classification", "allow", null],
        ["secret", "SealAnnex", "test.Annex", "policy", "deny", "Requires one of roles [analyst], subject has [reader]"]
      ]);
      expect(await listed(cuiAnalyst)).toEqual([
        ["cui-analyst", "FileAnnex", "test.Annex", "policy", "allow", null],
        ["cui-analyst", "FileAnnex", "test.Annex", "classification", "deny", "Requires a higher clearance"],
        ["cui-analyst", "SealAnnex", "test.Annex", "policy", "allow", null],
        ["cui-analyst", "SealAnnex", "test.Annex", "classification", "deny", "Requires a higher clearance"]
      ]);
    });

    it("writes exactly the decision rows invokeAction's gates write for the same identity and Action", async () => {
      for (const who of [uncleared, cui, secret, secretAnalyst, cuiAnalyst, topSecret]) {
        for (const actionName of ["FileAnnex", "SealAnnex"]) {
          const listing = await setup();
          const listed = await rowsWrittenBy(listing.registry, () => listing.runtime.listActions("test.Annex", who));
          const invoking = await setup();
          const invoked = await rowsWrittenBy(invoking.registry, () => invoking.runtime.invokeAction(actionName, { reportId: "r1" }, who));
          expect(listed.filter((row) => row[1] === actionName)).toEqual(invoked);
        }
      }
    });

    it("writes policy rows but no classification row for an Action on an unmarked Type", async () => {
      const { runtime, registry } = await setup();
      expect(await rowsWrittenBy(registry, () => runtime.listActions("test.Notice", cui))).toEqual([["cui", "PinNotice", "test.Notice", "policy", "allow", null]]);
    });

    it("choosing a default search's properties is query planning, not an access decision, and writes no row for the fields it skips", async () => {
      const { runtime, registry } = await setup();
      const rows = await rowsWrittenBy(registry, () => runtime.query({ type: "test.Report", search: { text: "no such text" } }, cui));
      // Nothing matched, so nothing was read: no classification row at all, not a deny per unsearched field.
      expect(rows.filter((row) => row[3] === "classification")).toEqual([]);
    });
  });

  describe("the scheme is pluggable, and fails closed", () => {
    it("a scheme that throws denies every marked read", async () => {
      const broken: ClassificationScheme = {
        name: "broken",
        dominates: () => {
          throw new Error("scheme unavailable");
        }
      };
      const { runtime } = await setup({ classification: broken });
      expect(keys(await runtime.getObject("test.Report", "r1", topSecret))).toEqual(["headline", "id", "title"]);
      await expect(runtime.getObject("test.Annex", "a1", topSecret)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("a compartmented lattice plugs in through the same interface", async () => {
      // Clearance "LEVEL/COMPARTMENT,…" dominates a marking of the same form when the level is at least as high
      // and every compartment is held.
      const levels = ["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"];
      const parse = (label: string) => {
        const [level, compartments = ""] = label.split("/");
        return { rank: levels.indexOf(level!), compartments: compartments.split(",").filter(Boolean) };
      };
      const lattice: ClassificationScheme = {
        name: "compartmented",
        dominates(clearance, marking) {
          const need = parse(marking);
          const have = parse(clearance ?? "UNCLASSIFIED");
          return need.rank >= 0 && have.rank >= need.rank && need.compartments.every((c) => have.compartments.includes(c));
        }
      };
      const { runtime } = await setup({ classification: lattice });
      expect((await runtime.getObject("test.Report", "r1", reader("ts-plain", "TOP_SECRET"))).values).toHaveProperty("sourceName");
      expect((await runtime.getObject("test.Notice", "n1", reader("s-alpha", "SECRET/ALPHA"))).values).toHaveProperty("location");
      expect((await runtime.getObject("test.Report", "r1", reader("s-alpha", "SECRET/ALPHA"))).values).not.toHaveProperty("sourceName");
    });
  });
});
