import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort, computeAggregations } from "../src/runtime/query-ops.js";
import { parseResolution } from "../src/runtime/resolution.js";
import { AbacPolicyEngine, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { AggregateResult, QueryFilter, SemanticAggregateQuery, SortKey } from "../src/model/query.js";
import type { Identity, PolicyDecision, PolicyEngine, PolicyRequest } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Row-level (instance) authorization, ADR-0030. A small case-tracking model:
 * a Team has Cases, a Case has Notes. A Case is readable by its owner, its
 * reviewer, or an auditor — decided on each Case's own stored attributes —
 * while Teams and Notes stay role-level (public), so every test also shows a
 * role-only rule deciding exactly as before beside an instance rule.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Team": { t1: { id: "t1", name: "Facilities" } },
  "test.Case": {
    c1: { id: "c1", teamId: "t1", ownerId: "alice", reviewerId: "bob", title: "Leak in lab", reviewNotes: "RN-ALPHA", summary: "S-ALPHA" },
    c2: { id: "c2", teamId: "t1", ownerId: "bob", title: "Broken badge", reviewNotes: "RN-BRAVO", summary: "S-BRAVO" },
    c3: { id: "c3", teamId: "t1", ownerId: "carol", title: "Server fire", summary: "S-CHARLIE" }
  },
  "test.Note": {
    n1: { id: "n1", caseId: "c1", text: "photos attached" },
    n2: { id: "n2", caseId: "c1", text: "plumber booked" },
    n3: { id: "n3", caseId: "c2", text: "badge reissued" },
    n4: { id: "n4", caseId: "c3", text: "halon discharged" }
  }
};

/** Every stored value of a Case the caller must never see — none may appear in an error, a reason, or the audit log. */
const CASE_SECRETS = ["RN-ALPHA", "RN-BRAVO", "S-ALPHA", "S-BRAVO", "S-CHARLIE", "Leak in lab", "Broken badge", "Server fire", "carol"];

class CaseAdapter implements Adapter {
  readonly dataSourceId = "cases-ds";
  /** `Type/id` for every resolveProperties call, and the source id of every resolveRelationship call. */
  readonly propertyReads: string[] = [];
  readonly relationshipReads: string[] = [];

  private rows(typeName: string) {
    return Object.entries(DATA[typeName] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(objectId, values) }));
  }
  private prov(objectId: string, values: Record<string, unknown>) {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: "cases", recordId: objectId, field },
      retrievedAt: "2026-01-01T00:00:00.000Z"
    }));
  }
  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.propertyReads.push(`${typeName}/${objectId}`);
    const values = DATA[typeName]?.[objectId] ?? {};
    return { values: { ...values }, provenance: this.prov(objectId, values) };
  }
  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    const sorted = applySort(this.rows(typeName).filter((r) => matchesFilter(r.values, filter)), sort, (r) => r.values);
    const start = cursor ? Number(cursor) : 0;
    const end = start + (limit ?? sorted.length);
    return { items: sorted.slice(start, end), nextCursor: end < sorted.length ? String(end) : undefined };
  }
  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    this.relationshipReads.push(sourceObjectId);
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind === "byOwnField") {
      const target = DATA[relationship.sourceType]?.[sourceObjectId]?.[strategy.field];
      return typeof target === "string" ? [{ objectId: target }] : [];
    }
    if (strategy.kind !== "byForeignKey") throw new Error(`unsupported ${strategy.kind}`);
    return this.rows(relationship.targetType)
      .filter((r) => r.values[strategy.field] === sourceObjectId)
      .map((r) => ({ objectId: r.objectId }));
  }
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    return computeAggregations(this.rows(query.type).map((r) => r.values).filter((v) => matchesFilter(v, query.filter)), query);
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const alice: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };
const bob: Identity = { subjectId: "bob", roles: ["staff"], attributes: { userId: "bob" } };
const auditor: Identity = { subjectId: "auditor", roles: ["auditor"], attributes: {} };
/** Staff with no userId: the case where `undefined === undefined` must never read as a match. */
const mallory: Identity = { subjectId: "mallory", roles: ["staff"], attributes: {} };

const RULES: Record<string, PolicyRule> = {
  public: allowAllRule,
  "case.read": anyOf(requireRole("auditor"), requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("reviewerId", "userId")),
  "case.reviewer": requireAttributeMatch("reviewerId", "userId")
};

async function registerType(registry: SemanticRegistry, name: string, schema: Omit<SemanticTypeSchema, "$id" | "type">, headlineCalls: string[]) {
  const short = name.split(".")[1]!;
  await registry.registerType({ $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, {
    name,
    version: "1.0.0",
    computedImplementations: {
      headline: async (ctx) => {
        headlineCalls.push(ctx.objectId);
        return String(await ctx.getProperty("title")).toUpperCase();
      }
    }
  });
  await registry.registerMapping({ id: `map-${short}`, typeName: name, target: "property", targetName: "*", dataSourceId: "cases-ds", operation: "get", resolutionMode: "live" });
}

async function setup(opts: { rules?: Record<string, PolicyRule>; policyEngine?: PolicyEngine } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const headlineCalls: string[] = [];
  await registerType(
    registry,
    "test.Case",
    {
      title: "Case",
      properties: Object.fromEntries(["id", "teamId", "ownerId", "reviewerId", "title", "reviewNotes", "summary"].map((p) => [p, { type: "string" }])),
      "x-relationships": {
        notes: { target: "test.Note", cardinality: "one-to-many", resolution: { dataSourceId: "cases-ds", operation: "byForeignKey:caseId" } }
      },
      "x-computed": { headline: { dependsOn: ["title"], binding: "headline" } },
      "x-policy": {
        objectPolicy: "case.read",
        // `reviewNotes` is instance-scoped; `summary` and `notes` carry an allow-all member policy, the
        // shape that used to *replace* the object policy on getProvenance/getRelationship.
        propertyPolicies: { reviewNotes: "case.reviewer", summary: "public", notes: "public" }
      }
    },
    headlineCalls
  );
  await registerType(
    registry,
    "test.Note",
    {
      title: "Note",
      properties: { id: { type: "string" }, caseId: { type: "string" }, text: { type: "string" } },
      "x-relationships": {
        case: { target: "test.Case", cardinality: "one-to-one", resolution: { dataSourceId: "cases-ds", operation: "byOwnField:caseId" } }
      },
      "x-policy": { objectPolicy: "public" }
    },
    headlineCalls
  );
  await registerType(
    registry,
    "test.Team",
    {
      title: "Team",
      properties: { id: { type: "string" }, name: { type: "string" } },
      "x-relationships": {
        cases: { target: "test.Case", cardinality: "one-to-many", resolution: { dataSourceId: "cases-ds", operation: "byForeignKey:teamId" } }
      },
      "x-policy": { objectPolicy: "public" }
    },
    headlineCalls
  );

  let policyEngine = opts.policyEngine;
  if (!policyEngine) {
    const abac = new AbacPolicyEngine();
    for (const [name, rule] of Object.entries(opts.rules ?? RULES)) abac.registerRule(name, rule);
    policyEngine = abac;
  }
  const adapter = new CaseAdapter();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine);
  return { runtime, registry, adapter, headlineCalls };
}

type Obj = { objectId: string; values: Record<string, unknown> };
const ids = (objs: unknown) => (objs as Obj[]).map((o) => o.objectId).sort();

async function auditRows(registry: SemanticRegistry) {
  return (await registry.listAuditEvents({ limit: 1000 })).items;
}

describe("Row-level authorization (ADR-0030)", () => {
  describe("what a rule is given", () => {
    it("an instance request carries the object's stored attributes: pre-redaction, frozen, and without computed properties", async () => {
      const seen: PolicyRequest[] = [];
      const { runtime } = await setup({ rules: { ...RULES, "case.read": (req) => (seen.push(req), { allow: true }) } });

      const read = await runtime.getObject("test.Case", "c1", alice);

      const request = seen.find((r) => r.resource.objectId === "c1" && r.resource.propertyPath === undefined)!;
      expect(request.resource.attributes).toEqual(DATA["test.Case"]!.c1);
      expect(request.resource.attributes).toHaveProperty("reviewNotes", "RN-ALPHA"); // decided on, though alice can't see it
      expect(read.values).not.toHaveProperty("reviewNotes");
      expect(request.resource.attributes).not.toHaveProperty("headline");
      expect(Object.isFrozen(request.resource.attributes)).toBe(true);
    });

    it("a type-level request (aggregate, filter property check) carries no attributes", async () => {
      const seen: PolicyRequest[] = [];
      const spy: PolicyRule = (req) => (seen.push(req), { allow: true });
      const { runtime } = await setup({ rules: { ...RULES, "case.read": spy, "case.reviewer": spy } });

      await runtime.aggregate({ type: "test.Case", aggregations: [{ name: "n", op: "count" }] }, auditor);
      await runtime.query({ type: "test.Case", filter: { property: "reviewNotes", operator: "eq", value: "x" } }, auditor);

      const typeLevel = seen.filter((r) => r.resource.objectId === undefined);
      expect(typeLevel.map((r) => r.policyName).sort()).toEqual(["case.read", "case.reviewer"]);
      for (const r of typeLevel) expect(r.resource.attributes).toBeUndefined();
    });
  });

  describe("every read path decides on the instance", () => {
    it("getObject allows the owner and the reviewer, and denies anyone else", async () => {
      const { runtime } = await setup();
      expect((await runtime.getObject("test.Case", "c1", alice)).values.title).toBe("Leak in lab");
      expect((await runtime.getObject("test.Case", "c1", bob)).values.title).toBe("Leak in lab");
      await expect(runtime.getObject("test.Case", "c3", alice)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("query decides per returned item and silently drops the rest, auditing each decision", async () => {
      const { runtime, registry } = await setup();
      expect(ids((await runtime.query({ type: "test.Case" }, alice)).items)).toEqual(["c1"]);
      expect(ids((await runtime.query({ type: "test.Case" }, bob)).items)).toEqual(["c1", "c2"]);
      expect(ids((await runtime.query({ type: "test.Case" }, auditor)).items)).toEqual(["c1", "c2", "c3"]);

      const aliceRows = (await auditRows(registry)).filter((e) => e.subjectId === "alice" && !e.resource.propertyPath);
      expect(aliceRows.map((e) => [e.resource.objectId, e.decision]).sort()).toEqual([
        ["c1", "allow"],
        ["c2", "deny"],
        ["c3", "deny"]
      ]);
    });

    it("an unauthorized caller gets an empty page, not an error — the object policy never refuses the query itself", async () => {
      const { runtime } = await setup();
      await expect(runtime.query({ type: "test.Case" }, mallory)).resolves.toEqual({ items: [], nextCursor: undefined });
    });

    it("a denied item is never finalized (no computed properties) and never navigated (no includes)", async () => {
      const { runtime, adapter, headlineCalls } = await setup();
      const { items } = await runtime.query({ type: "test.Case", include: [{ relationship: "notes" }] }, alice);

      expect(ids(items)).toEqual(["c1"]);
      expect(headlineCalls).toEqual(["c1"]);
      expect(adapter.relationshipReads).toEqual(["c1"]);
    });

    it("getRelationship requires a readable source, then decides every related object on its own attributes", async () => {
      const { runtime } = await setup();
      await expect(runtime.getRelationship("test.Case", "c3", "notes", alice)).rejects.toBeInstanceOf(AuthorizationError);
      expect(ids(await runtime.getRelationship("test.Case", "c1", "notes", alice))).toEqual(["n1", "n2"]);
      expect(ids(await runtime.getRelationship("test.Team", "t1", "cases", alice))).toEqual(["c1"]);
      expect(ids(await runtime.getRelationship("test.Team", "t1", "cases", auditor))).toEqual(["c1", "c2", "c3"]);
    });

    it("an include authorizes each level on that level's own attributes, and never re-resolves an authorized source", async () => {
      const { runtime, adapter } = await setup();
      const { items } = await runtime.query(
        { type: "test.Team", include: [{ relationship: "cases", include: [{ relationship: "notes" }] }] },
        bob
      );
      const cases = items[0]!.values.cases as Obj[];
      expect(ids(cases)).toEqual(["c1", "c2"]);
      expect(Object.fromEntries(cases.map((c) => [c.objectId, ids(c.values.notes)]))).toEqual({ c1: ["n1", "n2"], c2: ["n3"] });

      // Each case was resolved once, to authorize and finalize it — the notes include reused those attributes.
      const caseReads = adapter.propertyReads.filter((r) => r.startsWith("test.Case/"));
      expect(caseReads.sort()).toEqual(["test.Case/c1", "test.Case/c2", "test.Case/c3"]);
    });

    it("provenance is readable only where the value is", async () => {
      const { runtime } = await setup();
      await expect(runtime.getProvenance("test.Case", "c1", "title", alice)).resolves.toHaveLength(1);
      await expect(runtime.getProvenance("test.Case", "c3", "title", alice)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("a property policy can itself be instance-scoped", async () => {
      const { runtime } = await setup();
      expect((await runtime.getObject("test.Case", "c1", bob)).values.reviewNotes).toBe("RN-ALPHA"); // bob reviews c1
      expect((await runtime.getObject("test.Case", "c1", alice)).values).not.toHaveProperty("reviewNotes"); // alice owns, doesn't review
      expect((await runtime.getObject("test.Case", "c2", bob)).values).not.toHaveProperty("reviewNotes"); // c2 has no reviewer
    });

    it("aggregation over an instance-guarded Type fails closed, unless the rule allows unconditionally", async () => {
      const { runtime } = await setup();
      const count = { type: "test.Case", aggregations: [{ name: "n", op: "count" as const }] };
      await expect(runtime.aggregate(count, alice)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.aggregate(count, auditor)).resolves.toEqual({ groups: [{ key: {}, values: { n: 3 } }] });
    });
  });

  describe("role-only rules are unaffected", () => {
    it("a role-level Type returns every object, and a role-level deny is still a deny", async () => {
      const { runtime } = await setup({ rules: { ...RULES, public: requireRole("staff") } });
      expect(ids((await runtime.query({ type: "test.Note" }, alice)).items)).toEqual(["n1", "n2", "n3", "n4"]);
      await expect(runtime.getObject("test.Note", "n1", auditor)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await runtime.query({ type: "test.Note" }, auditor)).items).toEqual([]);
    });
  });

  describe("attack: reading a Case you may not read", () => {
    it("cannot via getObject, query, or search", async () => {
      const { runtime } = await setup();
      await expect(runtime.getObject("test.Case", "c3", alice)).rejects.toBeInstanceOf(AuthorizationError);
      expect(ids((await runtime.query({ type: "test.Case", filter: { property: "id", operator: "eq", value: "c3" } }, alice)).items)).toEqual([]);
      expect(ids((await runtime.query({ type: "test.Case", filter: { property: "ownerId", operator: "eq", value: "carol" } }, alice)).items)).toEqual([]);
      expect(ids((await runtime.query({ type: "test.Case", search: { text: "fire" } }, alice)).items)).toEqual([]);
    });

    it("cannot via a relationship include, at any depth", async () => {
      const { runtime } = await setup();
      const fromNotes = await runtime.query({ type: "test.Note", include: [{ relationship: "case" }] }, alice);
      const reached = fromNotes.items.flatMap((n) => ids(n.values.case));
      expect(new Set(reached)).toEqual(new Set(["c1"]));

      const fromTeam = await runtime.query({ type: "test.Team", include: [{ relationship: "cases", include: [{ relationship: "notes" }] }] }, alice);
      expect(ids(fromTeam.items[0]!.values.cases)).toEqual(["c1"]);
    });

    it("cannot via a relationship or provenance whose own member policy allows everyone", async () => {
      const { runtime } = await setup();
      // `notes` and `summary` are "public" members of a Case alice can't read: the member narrows, never replaces.
      await expect(runtime.getRelationship("test.Case", "c3", "notes", alice)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getProvenance("test.Case", "c3", "summary", alice)).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("cannot via an include filter or sort that probes a hidden instance", async () => {
      const { runtime } = await setup();
      const probed = await runtime.query(
        { type: "test.Team", include: [{ relationship: "cases", filter: { property: "ownerId", operator: "eq", value: "carol" } }] },
        alice
      );
      expect(probed.items[0]!.values.cases).toEqual([]);
    });

    it("cannot count hidden rows through aggregation or filter on an instance-scoped field", async () => {
      const { runtime } = await setup();
      await expect(
        runtime.aggregate({ type: "test.Case", groupBy: ["ownerId"], aggregations: [{ name: "n", op: "count" }] }, alice)
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        runtime.query({ type: "test.Case", filter: { property: "reviewNotes", operator: "eq", value: "RN-BRAVO" } }, bob)
      ).rejects.toBeInstanceOf(AuthorizationError);
    });

    it("an identity with no userId never matches a Case with no reviewer (undefined === undefined is not a match)", async () => {
      const { runtime } = await setup();
      await expect(runtime.getObject("test.Case", "c2", mallory)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getObject("test.Case", "c3", mallory)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await runtime.query({ type: "test.Case" }, mallory)).items).toEqual([]);
    });

    it("an identity attribute of the wrong shape never matches", async () => {
      const { runtime } = await setup();
      for (const userId of [["alice"], { toString: () => "alice" }, "", null, Number.NaN]) {
        const forged: Identity = { subjectId: "forger", roles: ["staff"], attributes: { userId } };
        await expect(runtime.getObject("test.Case", "c1", forged)).rejects.toBeInstanceOf(AuthorizationError);
      }
    });

    it("every denial is audited, and no stored value reaches the audit log, the error, or its reason", async () => {
      const { runtime, registry } = await setup();
      const errors: AuthorizationError[] = [];
      const capture = (p: Promise<unknown>) => p.catch((e: unknown) => void errors.push(e as AuthorizationError));

      await capture(runtime.getObject("test.Case", "c3", alice));
      await capture(runtime.getRelationship("test.Case", "c3", "notes", alice));
      await capture(runtime.getProvenance("test.Case", "c3", "summary", alice));
      await runtime.query({ type: "test.Case", include: [{ relationship: "notes" }] }, alice);
      await runtime.query({ type: "test.Note", include: [{ relationship: "case" }] }, alice);

      expect(errors).toHaveLength(3);
      for (const e of errors) expect(e).toBeInstanceOf(AuthorizationError);

      const denials = (await auditRows(registry)).filter((e) => e.subjectId === "alice" && e.decision === "deny");
      // getObject, getRelationship, getProvenance, the query's c2 + c3, and the includes reaching c2 + c3 via notes.
      expect(denials.filter((e) => e.resource.objectId === "c3").length).toBeGreaterThanOrEqual(5);
      expect(denials.filter((e) => e.resource.objectId === "c2").length).toBeGreaterThanOrEqual(2);

      const leaked = JSON.stringify({ audit: await auditRows(registry), errors: errors.map((e) => [e.message, e.reason]) });
      for (const secret of CASE_SECRETS) expect(leaked).not.toContain(secret);
    });
  });

  describe("the enforcement point is deny-biased", () => {
    it("a rule that throws is an audited deny, and its error message is not surfaced", async () => {
      const throwing: PolicyRule = () => {
        throw new Error("lookup failed for owner carol");
      };
      const { runtime, registry } = await setup({ rules: { ...RULES, "case.read": throwing } });

      const err = (await runtime.getObject("test.Case", "c1", alice).then(
        () => undefined,
        (e: unknown) => e
      )) as AuthorizationError;
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(`${err.message} ${err.reason}`).not.toContain("carol");
      expect((await runtime.query({ type: "test.Case" }, alice)).items).toEqual([]);

      const rows = (await auditRows(registry)).filter((e) => e.resource.objectId === "c1");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((e) => e.decision === "deny" && !e.reason?.includes("carol"))).toBe(true);
    });

    it("a rule cannot alter the attributes, so it cannot change what the caller is returned", async () => {
      const tampering: PolicyRule = (req) => {
        (req.resource.attributes as Record<string, unknown>).ownerId = req.subject.attributes.userId;
        return { allow: true };
      };
      const { runtime } = await setup({ rules: { ...RULES, "case.read": tampering } });
      await expect(runtime.getObject("test.Case", "c3", alice)).rejects.toBeInstanceOf(AuthorizationError);
      expect((await runtime.query({ type: "test.Case" }, alice)).items).toEqual([]);
      expect(DATA["test.Case"]!.c3!.ownerId).toBe("carol");
    });

    it("an engine's malformed decision is a deny, in reads and in listActions", async () => {
      for (const answer of [{ allow: "yes" }, { allow: 1 }, undefined, null, {}] as unknown as PolicyDecision[]) {
        const malformed: PolicyEngine = { evaluate: async () => answer };
        const { runtime } = await setup({ policyEngine: malformed });
        await expect(runtime.getObject("test.Note", "n1", alice)).rejects.toBeInstanceOf(AuthorizationError);
        expect((await runtime.query({ type: "test.Note" }, alice)).items).toEqual([]);
      }
    });

    it("an engine that rejects is a deny", async () => {
      const failing: PolicyEngine = { evaluate: () => Promise.reject(new Error("policy service unreachable")) };
      const { runtime } = await setup({ policyEngine: failing });
      await expect(runtime.getObject("test.Note", "n1", alice)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(runtime.getRelationship("test.Team", "t1", "cases", auditor)).rejects.toBeInstanceOf(AuthorizationError);
    });
  });
});
