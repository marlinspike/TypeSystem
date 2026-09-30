import { describe, it, expect } from "vitest";
import {
  ALWAYS,
  NEVER,
  allPlans,
  anyPlan,
  checkPlan,
  isExact,
  limitationsOf,
  planAdmits,
  predicateAdmits,
  predicatePlan,
  predicateToFilter,
  refitPredicate,
  unknownPlan,
  type AuthorizationPlan,
  type AuthorizationPredicate
} from "../src/policy/authorization-plan.js";
import { AbacPolicyEngine, allOf, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { checkPlanConformance } from "../src/testing/plan-conformance.js";
import { matchesFilter } from "../src/runtime/filter.js";
import type { Identity, PolicyEngine, PolicyRequest } from "../src/model/policy.js";

/** ADR-0038: plans, their combinators, and the ABAC planner — which must be sound, and exact where it says so. */

/** A small deterministic PRNG, so generated cases are the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const OPAQUE_LIMIT = { code: "opaque-rule", policyName: "p" } as const;
const atom = (attribute: string, eq: string | number): AuthorizationPredicate => ({ attribute, eq });
const P = predicatePlan(atom("ownerId", "alice"));
const Q = predicatePlan(atom("reviewerId", "alice"));
const U = unknownPlan([OPAQUE_LIMIT]);

describe("authorization plans (ADR-0038)", () => {
  describe("constructors enforce exactness", () => {
    it("a predicate plan is exact exactly when it has no limitations, and is frozen", () => {
      expect(P).toEqual({ kind: "predicate", predicate: atom("ownerId", "alice"), exact: true, limitations: [] });
      expect(predicatePlan(atom("a", 1), [OPAQUE_LIMIT])).toMatchObject({ exact: false, limitations: [OPAQUE_LIMIT] });
      expect(Object.isFrozen(P)).toBe(true);
      expect(Object.isFrozen(ALWAYS) && Object.isFrozen(NEVER)).toBe(true);
    });

    it("an unknown plan must say why, and repeated reasons collapse", () => {
      expect(() => unknownPlan([])).toThrow(TypeError);
      expect(limitationsOf(unknownPlan([OPAQUE_LIMIT, { ...OPAQUE_LIMIT }]))).toEqual([OPAQUE_LIMIT]);
    });
  });

  describe("simplification recovers exactness", () => {
    it("never AND anything is never, exactly; always OR anything is always, exactly", () => {
      expect(allPlans([NEVER, U])).toBe(NEVER);
      expect(allPlans([U, predicatePlan(atom("a", 1), [OPAQUE_LIMIT]), NEVER])).toBe(NEVER);
      expect(anyPlan([ALWAYS, U])).toBe(ALWAYS);
      expect(anyPlan([U, ALWAYS])).toBe(ALWAYS);
    });

    it("always drops out of AND and never out of OR, keeping exactness", () => {
      expect(allPlans([ALWAYS, P])).toEqual(P);
      expect(anyPlan([NEVER, P])).toEqual(P);
      expect(allPlans([])).toBe(ALWAYS);
      expect(anyPlan([])).toBe(NEVER);
      expect(allPlans([ALWAYS, ALWAYS])).toBe(ALWAYS);
      expect(anyPlan([NEVER, NEVER])).toBe(NEVER);
    });

    it("unknown weakens an AND to the rest — narrowing, no longer exact — and swallows an OR", () => {
      expect(allPlans([P, U])).toEqual(predicatePlan(atom("ownerId", "alice"), [OPAQUE_LIMIT]));
      expect(anyPlan([P, U])).toEqual(U);
      expect(allPlans([U])).toEqual(U);
    });

    it("nested ANDs and ORs flatten", () => {
      const nested = anyPlan([anyPlan([P, Q]), predicatePlan(atom("teamId", "t1"))]);
      expect(nested).toMatchObject({ kind: "predicate", exact: true, predicate: { or: [atom("ownerId", "alice"), atom("reviewerId", "alice"), atom("teamId", "t1")] } });
    });
  });

  describe("checkPlan: what an engine returns is rebuilt, or rejected as a planner defect", () => {
    it("accepts every well-formed plan", () => {
      for (const plan of [ALWAYS, NEVER, P, U, anyPlan([P, Q]), predicatePlan(atom("n", 3), [{ code: "protected-attribute", attribute: "n" }])]) {
        expect(checkPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
      }
    });

    it("rejects claimed exactness its limitations contradict, and every malformed shape", () => {
      const bad: unknown[] = [
        undefined, null, "always", 7, {}, { kind: "sometimes" },
        { kind: "predicate", predicate: atom("a", "x"), exact: true, limitations: [OPAQUE_LIMIT] },
        { kind: "predicate", predicate: atom("a", "x"), exact: false, limitations: [] },
        { kind: "predicate", predicate: atom("a", "x"), limitations: [] },
        { kind: "unknown", limitations: [] },
        { kind: "unknown", limitations: [{ code: "because" }] },
        { kind: "unknown", limitations: [{ code: "opaque-rule" }] },
        { kind: "unknown" },
        ...[{ attribute: "", eq: "x" }, { attribute: "a", eq: "" }, { attribute: "a", eq: Number.NaN }, { attribute: "a", eq: null }, { attribute: "a", eq: ["x"] },
          { attribute: "a", eq: "x", extra: 1 }, { and: [] }, { or: [] }, { and: [atom("a", 1)], or: [atom("b", 1)] }, { not: atom("a", 1) }]
          .map((predicate) => ({ kind: "predicate", predicate, exact: true, limitations: [] }))
      ];
      for (const value of bad) expect(checkPlan(value)).toBeUndefined();
      let deep: AuthorizationPredicate = atom("a", 1);
      for (let i = 0; i < 100; i++) deep = { and: [deep] };
      expect(checkPlan({ kind: "predicate", predicate: deep, exact: true, limitations: [] })).toBeUndefined();
    });
  });

  describe("properties, over generated predicates and objects", () => {
    const ATTRS = ["ownerId", "reviewerId", "teamId", "constructor", "__proto__"];
    const VALUES: unknown[] = ["alice", "bob", 7, "7", "", null, undefined, Number.NaN, ["alice"]];
    function predicate(next: () => number, depth = 0): AuthorizationPredicate {
      const r = next();
      if (depth > 3 || r < 0.5) return atom(ATTRS[Math.floor(next() * 3)]!, (["alice", "bob", 7, "7"] as const)[Math.floor(next() * 4)]!);
      const children = Array.from({ length: 1 + Math.floor(next() * 3) }, () => predicate(next, depth + 1));
      return r < 0.75 ? { and: children } : { or: children };
    }
    function object(next: () => number): Record<string, unknown> {
      const o: Record<string, unknown> = JSON.parse("{}") as Record<string, unknown>;
      for (const a of ATTRS) if (next() < 0.6) Object.defineProperty(o, a, { value: VALUES[Math.floor(next() * VALUES.length)], enumerable: true, writable: true, configurable: true });
      return o;
    }

    it("pushed down to the query filter DSL, a predicate matches exactly the objects it admits", () => {
      const next = rng(38);
      for (let i = 0; i < 2000; i++) {
        const p = predicate(next);
        const o = object(next);
        expect(matchesFilter(o, predicateToFilter(p))).toBe(predicateAdmits(p, o));
      }
    });

    it("weakening any atoms to true only ever admits more — including a disjunct — and says so", () => {
      const next = rng(1038);
      for (let i = 0; i < 2000; i++) {
        const p = predicate(next);
        const weak = new Set(ATTRS.filter(() => next() < 0.3));
        const fitted = refitPredicate(p, (a) => (weak.has(a.attribute) ? unknownPlan([{ code: "protected-attribute", attribute: a.attribute }]) : predicatePlan(a)));
        for (let j = 0; j < 5; j++) {
          const o = object(next);
          if (predicateAdmits(p, o)) expect(planAdmits(fitted, o)).toBe(true);
        }
        if (isExact(fitted) && fitted.kind === "predicate") expect(fitted.limitations).toEqual([]);
      }
    });

    it("refitting every atom to itself changes nothing", () => {
      const next = rng(2038);
      for (let i = 0; i < 500; i++) {
        const p = predicate(next);
        const same = refitPredicate(p, (a) => predicatePlan(a));
        for (let j = 0; j < 5; j++) {
          const o = object(next);
          expect(planAdmits(same, o)).toBe(predicateAdmits(p, o));
        }
        expect(isExact(same)).toBe(true);
      }
    });
  });
});

describe("the ABAC planner (ADR-0038)", () => {
  const who = (attributes: Record<string, unknown>, roles: string[] = ["staff"]): Identity => ({ subjectId: `s-${JSON.stringify(attributes)}-${roles.join("")}`, roles, attributes });
  const request = (subject: Identity, policyName = "p"): PolicyRequest => ({ subject, action: "read", policyName, resource: { typeName: "T" } });
  const engineWith = (rules: Record<string, PolicyRule>) => {
    const engine = new AbacPolicyEngine();
    for (const [name, rule] of Object.entries(rules)) engine.registerRule(name, rule);
    return engine;
  };
  const planFor = (rule: PolicyRule, subject: Identity) => engineWith({ p: rule }).plan(request(subject));
  const opaque: PolicyRule = () => ({ allow: false });

  it("each combinator plans from the structure it evaluates", async () => {
    const alice = who({ userId: "alice" });
    expect(await planFor(allowAllRule, alice)).toBe(ALWAYS);
    expect(await planFor(requireRole("staff"), alice)).toBe(ALWAYS);
    expect(await planFor(requireRole("auditor"), alice)).toBe(NEVER);
    expect(await planFor(requireAttributeMatch("ownerId", "userId"), alice)).toEqual(P);
    expect(await planFor(anyOf(requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("reviewerId", "userId")), alice)).toEqual(anyPlan([P, Q]));
    expect(await planFor(allOf(requireRole("staff"), requireAttributeMatch("ownerId", "userId")), alice)).toEqual(P);
  });

  it("a subject with no usable value plans never — missing, empty, or the wrong shape", async () => {
    for (const userId of [undefined, "", null, Number.NaN, Number.POSITIVE_INFINITY, ["alice"], { toString: () => "alice" }, true]) {
      const attributes = userId === undefined ? {} : { userId };
      expect(await planFor(requireAttributeMatch("ownerId", "userId"), who(attributes))).toBe(NEVER);
    }
    expect(await planFor(requireAttributeMatch("ownerId", "userId"), who({ userId: 7 }))).toEqual(predicatePlan(atom("ownerId", 7)));
  });

  it("an opaque rule is unknown; around it, simplification keeps what can be known", async () => {
    const alice = who({ userId: "alice" });
    const u = unknownPlan([{ code: "opaque-rule", policyName: "p" }]);
    expect(await planFor(opaque, alice)).toEqual(u);
    expect(await planFor(anyOf(requireRole("staff"), opaque), alice)).toBe(ALWAYS);
    expect(await planFor(allOf(requireRole("auditor"), opaque), alice)).toBe(NEVER);
    expect(await planFor(allOf(opaque, requireAttributeMatch("ownerId", "userId")), alice)).toEqual(predicatePlan(atom("ownerId", "alice"), [{ code: "opaque-rule", policyName: "p" }]));
    expect(await planFor(anyOf(opaque, requireAttributeMatch("ownerId", "userId")), alice)).toEqual(u);
  });

  it("an unregistered policy denies everything, so it plans never", async () => {
    expect(await new AbacPolicyEngine().plan(request(who({})))).toBe(NEVER);
  });

  describe("differential conformance: sound for every subject and object, exact wherever it says so", () => {
    const subjects: Identity[] = [
      ...["alice", "bob", 7, "7", "", null, ["alice"]].map((userId) => who({ userId })),
      who({}),
      who({ userId: "alice" }, ["auditor"]),
      who({ userId: "bob" }, ["auditor", "staff"]),
      who({ userId: "alice" }, [])
    ];
    const values: unknown[] = ["alice", "bob", 7, "7", "", null, Number.NaN, ["alice"], undefined];
    const objects: Record<string, unknown>[] = [];
    for (const ownerId of values) for (const reviewerId of values) {
      const o: Record<string, unknown> = {};
      if (ownerId !== undefined) o.ownerId = ownerId;
      if (reviewerId !== undefined) o.reviewerId = reviewerId;
      objects.push(o);
    }
    const rules: Record<string, PolicyRule> = {
      open: allowAllRule,
      staff: requireRole("staff"),
      owner: requireAttributeMatch("ownerId", "userId"),
      "owner-or-reviewer-or-auditor": anyOf(requireRole("auditor"), requireAttributeMatch("ownerId", "userId"), requireAttributeMatch("reviewerId", "userId")),
      "staff-owner": allOf(requireRole("staff"), requireAttributeMatch("ownerId", "userId")),
      "nested": anyOf(allOf(requireRole("auditor"), requireAttributeMatch("reviewerId", "userId")), allOf(requireRole("staff"), anyOf(requireAttributeMatch("ownerId", "userId"), requireRole("admin")))),
      "with-opaque-and": allOf(opaque, requireAttributeMatch("ownerId", "userId")),
      "with-opaque-or": anyOf((req) => ({ allow: req.resource.attributes?.reviewerId === "bob" }), requireAttributeMatch("ownerId", "userId"))
    };
    const cases = { typeName: "T", policyNames: [...Object.keys(rules), "unregistered"], subjects, objects };

    it("finds no violation in the ABAC planner", async () => {
      expect(await checkPlanConformance(engineWith(rules), cases)).toEqual([]);
    });

    it("and catches a planner that hides authorized data, one that overclaims exactness, and one that fails", async () => {
      const base = engineWith(rules);
      const lying = (plan: (r: PolicyRequest) => Promise<AuthorizationPlan>): PolicyEngine => ({ evaluate: (r) => base.evaluate(r), plan });
      const hides = await checkPlanConformance(lying(async () => NEVER), cases);
      expect(hides.some((v) => v.violation === "unsound" && v.policyName === "open")).toBe(true);
      const overclaims = await checkPlanConformance(lying(async () => ALWAYS), cases);
      expect(overclaims.some((v) => v.violation === "overclaimed-exactness" && v.policyName === "owner")).toBe(true);
      expect(overclaims.some((v) => v.violation === "unsound")).toBe(false);
      const fails = await checkPlanConformance(lying(() => Promise.reject(new Error("down"))), cases);
      expect(fails).toHaveLength(subjects.length * cases.policyNames.length);
      expect(fails.every((v) => v.violation === "planner-failed")).toBe(true);
    });
  });
});
