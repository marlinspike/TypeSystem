import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { ResidualResponse } from "@cedar-policy/cedar-wasm/nodejs";
import {
  ALWAYS,
  AuthorizationError,
  HIGH_ASSURANCE_V1,
  NEVER,
  SemanticRuntime,
  checkPlanConformance,
  isExact,
  planAdmits,
  predicatePlan,
  type AuthorizationPlan,
  type Identity,
  type PolicyEngine,
  type SemanticQuery
} from "@typesys/core";
import { buildAirforceTestbed } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities } from "@typesys/domain-hospital";
import { CedarPolicyEngine } from "../src/index.js";
import { planFromResiduals, translateResidual, type ResidualContext } from "../src/planner.js";

/**
 * ADR-0039: Cedar plans through partial evaluation. The translator is held
 * to soundness — and exactness where it claims it — against a reference
 * evaluator over generated residuals, then the real engine against its own
 * decisions and the runtime's results against the planner-less runtime's.
 */
const SCHEMA = readFileSync(new URL("../examples/demo-domains.cedarschema", import.meta.url), "utf8");
const POLICIES = readFileSync(new URL("../examples/demo-domains.cedar", import.meta.url), "utf8");
const engine = (schemaConformantData = false) => new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES, schemaConformantData });
const withoutPlanner = (e: PolicyEngine): PolicyEngine => ({ evaluate: (r) => e.evaluate(r) });

const CTX: ResidualContext = { policyName: "p", cedarType: "h::P", typeName: "h.P", declaresAttributes: false, schemaConformantData: false };
const R = { unknown: [{ Value: "resource" }] };
const attr = (a: string) => ({ ".": { left: R, attr: a } });
const eq = (a: string, v: unknown) => ({ "==": { left: attr(a), right: { Value: v } } });
const has = (a: string) => ({ has: { left: R, attr: a } });
const not = (e: unknown) => ({ "!": { arg: e } });
const and = (l: unknown, r: unknown) => ({ "&&": { left: l, right: r } });
const or = (l: unknown, r: unknown) => ({ "||": { left: l, right: r } });
const like = (a: string, prefix: string) => ({ like: { left: attr(a), pattern: [{ Literal: prefix }, "Wildcard"] } });
const lt = (a: string, n: number) => ({ "<": { left: attr(a), right: { Value: n } } });
const policy = (effect: "permit" | "forbid", ...when: unknown[]) => ({
  effect,
  principal: { op: "All" },
  action: { op: "All" },
  resource: { op: "All" },
  conditions: when.map((body) => ({ kind: "when", body }))
});
const response = (residuals: Record<string, unknown>, extra: Partial<ResidualResponse> = {}): ResidualResponse =>
  ({ decision: null, satisfied: [], errored: [], mayBeDetermining: [], mustBeDetermining: [], residuals, nontrivialResiduals: [], ...extra }) as ResidualResponse;
const unrepresentable = { kind: "unknown", limitations: [{ code: "unrepresentable-condition", policyName: "p" }] };

describe("Cedar residuals to plans (ADR-0039)", () => {
  describe("shapes", () => {
    it("the demo rule's residual — has, != \"\", == — simplifies to one exact atom", () => {
      expect(translateResidual(and(and(has("owner"), not(eq("owner", ""))), eq("owner", "PR-2001")), CTX)).toEqual(predicatePlan({ attribute: "owner", eq: "PR-2001" }));
      expect(translateResidual(and({ Value: true }, and(eq("owner", 7), has("owner"))), CTX)).toEqual(predicatePlan({ attribute: "owner", eq: 7 }));
      expect(translateResidual({ "==": { left: { Value: "PR-1" }, right: attr("owner") } }, CTX)).toEqual(predicatePlan({ attribute: "owner", eq: "PR-1" }));
    });

    it("contradictions plan never, exactly — including over values an atom can't hold", () => {
      expect(translateResidual(and(eq("owner", "a"), eq("owner", "b")), CTX)).toBe(NEVER);
      expect(translateResidual(and(eq("owner", "a"), not(eq("owner", "a"))), CTX)).toBe(NEVER);
      expect(translateResidual(and(not(eq("owner", "")), eq("owner", "")), CTX)).toBe(NEVER);
      expect(translateResidual({ Value: false }, CTX)).toBe(NEVER);
    });

    it("is decides against the queried Type; is…in, and every shape it doesn't know, is true with the reason", () => {
      expect(translateResidual({ is: { left: R, entity_type: "h::P" } }, CTX)).toBe(ALWAYS);
      expect(translateResidual({ is: { left: R, entity_type: "h::Q" } }, CTX)).toBe(NEVER);
      for (const shape of [
        { is: { left: R, entity_type: "h::P", in: { Value: { __entity: { type: "g::G", id: "1" } } } } },
        has("owner"),
        not(eq("owner", "a")),
        like("owner", "x"),
        lt("level", 3),
        eq("owner", ""),
        eq("owner", ["a"]),
        { Value: "yes" },
        { "if-then-else": { if: has("a"), then: { Value: true }, else: { Value: false } } },
        R,
        { mystery: 1 },
        null,
        "&&"
      ]) {
        expect(translateResidual(shape, CTX)).toEqual(unrepresentable);
      }
    });

    it("attack: always OR a weakened subterm is not claimed exact — Cedar evaluates left to right, and an error denies", () => {
      // `x like "a*" || true`: if the left side errors, the whole policy errors, and the engine denies.
      const plan = planFromResiduals(response({ a: policy("permit", or(like("owner", "a"), { Value: true })) }), CTX);
      expect(plan).toEqual({ kind: "unknown", limitations: [{ code: "unrepresentable-condition", policyName: "p" }] });
      // And across policies: one permit that always holds doesn't make the plan exact beside another that might error.
      const across = planFromResiduals(response({ a: policy("permit", { Value: true }), b: policy("permit", like("owner", "a")) }), CTX);
      expect(isExact(across)).toBe(false);
    });

    it("weakening keeps what can be known: narrowed under AND, swallowed under OR", () => {
      expect(translateResidual(and(eq("owner", "a"), like("owner", "x")), CTX)).toEqual(predicatePlan({ attribute: "owner", eq: "a" }, [{ code: "unrepresentable-condition", policyName: "p" }]));
      expect(translateResidual(or(eq("owner", "a"), like("owner", "x")), CTX)).toEqual(unrepresentable);
      expect(translateResidual(or(eq("owner", "a"), { Value: true }), CTX)).toBe(ALWAYS);
    });
  });

  describe("responses", () => {
    it("an errored policy, or a decided deny, plans never; a decided allow plans always", () => {
      expect(planFromResiduals(response({ a: policy("permit", { Value: true }) }, { errored: ["b"] }), CTX)).toBe(NEVER);
      expect(planFromResiduals(response({}, { decision: "deny" }), CTX)).toBe(NEVER);
      expect(planFromResiduals(response({}, { decision: "allow" }), CTX)).toBe(ALWAYS);
    });

    it("permits combine; a forbid that always holds is never, one that never holds drops out, any other costs exactness", () => {
      const permits = { a: policy("permit", eq("owner", "x")), b: policy("permit", eq("reviewer", "x")), c: policy("permit", { Value: false }) };
      expect(planFromResiduals(response(permits), CTX)).toMatchObject({ kind: "predicate", exact: true, predicate: { or: [{ attribute: "owner", eq: "x" }, { attribute: "reviewer", eq: "x" }] } });
      expect(planFromResiduals(response({ ...permits, f: policy("forbid", { Value: true }) }), CTX)).toBe(NEVER);
      expect(isExact(planFromResiduals(response({ ...permits, f: policy("forbid", { Value: false }) }), CTX))).toBe(true);
      expect(planFromResiduals(response({ ...permits, f: policy("forbid", eq("owner", "blocked")) }), CTX)).toMatchObject({ exact: false, limitations: [{ code: "negated-condition", policyName: "p" }] });
      // A forbid only weakened to "true" is not one that always holds: it must not plan never.
      expect(planFromResiduals(response({ ...permits, f: policy("forbid", like("owner", "x")) }), CTX)).toMatchObject({ kind: "predicate", exact: false });
    });

    it("unless inverts only what it knows exactly; a still-constrained scope is weakened", () => {
      const unless = (body: unknown) => ({ ...policy("permit", eq("owner", "x")), conditions: [{ kind: "when", body: eq("owner", "x") }, { kind: "unless", body }] });
      expect(planFromResiduals(response({ a: unless({ Value: false }) }), CTX)).toEqual(predicatePlan({ attribute: "owner", eq: "x" }));
      expect(planFromResiduals(response({ a: unless({ Value: true }) }), CTX)).toBe(NEVER);
      expect(isExact(planFromResiduals(response({ a: unless(eq("level", 1)) }), CTX))).toBe(false);
      expect(planFromResiduals(response({ a: { ...policy("permit", { Value: true }), resource: { op: "==", entity: { type: "h::P", id: "1" } } } }), CTX)).toEqual(unrepresentable);
    });

    it("a Type with declared attributes is exact only on the schemaConformantData assertion; never stays exact", () => {
      const declared = { ...CTX, declaresAttributes: true };
      const permits = response({ a: policy("permit", eq("owner", "x")) });
      expect(planFromResiduals(permits, declared)).toMatchObject({ kind: "predicate", exact: false, limitations: [{ code: "unverified-attribute-types", typeName: "h.P" }] });
      expect(planFromResiduals(response({}, { decision: "allow" }), declared)).toEqual({ kind: "unknown", limitations: [{ code: "unverified-attribute-types", typeName: "h.P" }] });
      expect(planFromResiduals(response({}, { decision: "deny" }), declared)).toBe(NEVER);
      expect(isExact(planFromResiduals(permits, { ...declared, schemaConformantData: true }))).toBe(true);
    });
  });

  describe("soundness and exactness against a reference evaluator, over generated residuals", () => {
    /** Cedar's semantics for this grammar: a missing attribute errors, `&&`/`||` short-circuit, `==` is strict, `!` of an error errors. */
    type Out = boolean | "error";
    function evaluate(e: unknown, bag: Record<string, unknown>): Out {
      const op = e && typeof e === "object" ? Object.keys(e)[0] : undefined;
      const n = op ? (e as Record<string, Record<string, unknown>>)[op]! : {};
      const read = (a: unknown): unknown => (Object.hasOwn(bag, (a as { ".": { attr: string } })["."].attr) ? bag[(a as { ".": { attr: string } })["."].attr] : "error");
      switch (op) {
        case "Value":
          return (e as { Value: unknown }).Value === true ? true : (e as { Value: unknown }).Value === false ? false : "error";
        case "&&": {
          const l = evaluate(n.left, bag);
          return l === "error" ? "error" : l ? evaluate(n.right, bag) : false;
        }
        case "||": {
          const l = evaluate(n.left, bag);
          return l === "error" ? "error" : l ? true : evaluate(n.right, bag);
        }
        case "!": {
          const v = evaluate(n.arg, bag);
          return v === "error" ? "error" : !v;
        }
        case "has":
          return Object.hasOwn(bag, n.attr as string);
        case "==": {
          const v = read(n.left);
          return v === "error" ? "error" : v === (n.right as { Value: unknown }).Value;
        }
        case "like": {
          const v = read(n.left);
          return typeof v !== "string" ? "error" : v.startsWith(((n.pattern as { Literal: string }[])[0]!).Literal);
        }
        case "<": {
          const v = read(n.left);
          return typeof v !== "number" ? "error" : v < (n.right as { Value: number }).Value;
        }
        default:
          return "error";
      }
    }
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    }
    // What strict validation admits: each attribute has one type, literals match it, and an optional
    // attribute is read only behind `has`. Data conforms to the schema — the case in which a plan may be
    // exact at all (point 3).
    const TYPED: Record<string, readonly unknown[]> = { owner: ["a", "b", ""], reviewer: ["a", "b"], level: [1, 2, 3] };
    const ATTRS = Object.keys(TYPED);
    function gen(next: () => number, depth = 0): unknown {
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
      const r = next();
      if (depth > 3 || r < 0.4) {
        const leaf = next();
        const a = pick(ATTRS);
        if (leaf < 0.45) return and(has(a), eq(a, pick(TYPED[a]!)));
        if (leaf < 0.6) return has(a);
        if (leaf < 0.72) return a === "level" ? and(has(a), lt(a, 2)) : and(has(a), like(a, pick(["a", "b"])));
        if (leaf < 0.82) return and(has(a), not(eq(a, pick(TYPED[a]!))));
        return { Value: next() < 0.5 };
      }
      if (r < 0.65) return and(gen(next, depth + 1), gen(next, depth + 1));
      if (r < 0.85) return or(gen(next, depth + 1), gen(next, depth + 1));
      return not(gen(next, depth + 1));
    }
    function bag(next: () => number): Record<string, unknown> {
      const b: Record<string, unknown> = {};
      for (const a of ATTRS) if (next() < 0.7) b[a] = TYPED[a]![Math.floor(next() * TYPED[a]!.length)];
      return b;
    }

    it("a permit's plan admits every object the residual allows, and exactly those when it says it's exact", () => {
      const next = rng(39);
      let exact = 0;
      for (let i = 0; i < 4000; i++) {
        const residual = gen(next);
        const plan = planFromResiduals(response({ a: policy("permit", residual) }), CTX);
        if (isExact(plan)) exact++;
        for (let j = 0; j < 6; j++) {
          const b = bag(next);
          const allowed = evaluate(residual, b) === true;
          if (allowed) expect(planAdmits(plan, b)).toBe(true);
          if (isExact(plan)) expect(planAdmits(plan, b)).toBe(allowed);
        }
      }
      expect(exact).toBeGreaterThan(500); // not vacuous: plenty of exact plans were checked
    });

    it("with a forbid beside it, the plan still admits every object the pair allows", () => {
      const next = rng(1039);
      for (let i = 0; i < 2000; i++) {
        const [p, f] = [gen(next), gen(next)];
        const plan = planFromResiduals(response({ a: policy("permit", p), f: policy("forbid", f) }), CTX);
        for (let j = 0; j < 6; j++) {
          const b = bag(next);
          // Our evaluate denies on any error, and a forbid that holds denies.
          const [pv, fv] = [evaluate(p, b), evaluate(f, b)];
          if (pv === true && fv === false) expect(planAdmits(plan, b)).toBe(true);
        }
      }
    });
  });
});

describe("CedarPolicyEngine.plan on the demo policy set (ADR-0039)", () => {
  const who = (roles: string[], attributes: Record<string, unknown> = {}): Identity => ({ subjectId: `s-${roles.join("")}-${JSON.stringify(attributes)}`, roles, attributes });
  const planOf = (e: CedarPolicyEngine, subject: Identity, policyName: string, typeName: string) => e.plan({ subject, action: "read", policyName, resource: { typeName } });
  const clinician = hospitalDemoIdentities.clinician;

  it("plans each demo rule from Cedar's own residuals", async () => {
    const conformant = engine(true);
    expect(await planOf(conformant, clinician, "hospital.read-patient", "hospital.Patient")).toEqual(predicatePlan({ attribute: "assignedClinicianId", eq: "PR-2001" }));
    expect(await planOf(conformant, hospitalDemoIdentities.patient, "hospital.read-patient", "hospital.Patient")).toEqual(predicatePlan({ attribute: "id", eq: "PT-1001" }));
    expect(await planOf(conformant, who(["admin"]), "hospital.read-patient", "hospital.Patient")).toBe(ALWAYS);
    expect(await planOf(conformant, who(["viewer"]), "hospital.read-patient", "hospital.Patient")).toBe(NEVER);
    // Types that declare no attributes plan exactly without any assertion.
    const plain = engine();
    expect(await planOf(plain, who([]), "hospital.read-provider", "hospital.Provider")).toBe(ALWAYS);
    expect(await planOf(plain, clinician, "hospital.read-appointment", "hospital.Appointment")).toBe(ALWAYS);
    expect(await planOf(plain, who(["viewer"]), "hospital.read-appointment", "hospital.Appointment")).toBe(NEVER);
    expect(await planOf(plain, who(["maintainer"]), "airforce.read-aircraft", "airforce.Aircraft")).toBe(ALWAYS);
  });

  it("without the assertion — omitted, or anything but true — an attribute-bearing Type's plan is pushed down but not exact", async () => {
    const inexact = predicatePlan({ attribute: "assignedClinicianId", eq: "PR-2001" }, [{ code: "unverified-attribute-types", typeName: "hospital.Patient" }]);
    for (const e of [engine(), new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES }), new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES, schemaConformantData: "yes" as never })]) {
      expect(await planOf(e, clinician, "hospital.read-patient", "hospital.Patient")).toEqual(inexact);
    }
  });

  it("attack: a principal Cedar can't evaluate at all plans never, as every evaluation denies it", async () => {
    for (const attributes of [{ providerId: ["PR-2001"] }, { providerId: 2001 }, { providerId: { toString: () => "PR-2001" } }]) {
      const malformed = who(["clinician"], attributes);
      expect(await planOf(engine(true), malformed, "hospital.read-patient", "hospital.Patient")).toBe(NEVER);
      expect(await planOf(engine(true), malformed, "hospital.read-appointment", "hospital.Appointment")).toBe(NEVER);
    }
    expect(await planOf(engine(true), who(["clinician"], { providerId: "" }), "hospital.read-patient", "hospital.Patient")).toBe(NEVER);
  });

  describe("differential conformance against Cedar's own decisions", () => {
    const subjects: Identity[] = [
      clinician,
      hospitalDemoIdentities.otherClinician,
      hospitalDemoIdentities.patient,
      hospitalDemoIdentities.anonymous,
      who(["admin"]),
      who(["clinician"]),
      who(["clinician"], { providerId: "" }),
      who(["clinician"], { providerId: ["PR-2001"] }),
      who(["patient"], { patientId: "" }),
      who(["clinician", "patient"], { providerId: "PR-2002", patientId: "PT-1001" }),
      who(["Admin", " clinician"], { providerId: "PR-2001" })
    ];
    const wellTyped = [
      { id: "PT-1001", assignedClinicianId: "PR-2001" },
      { id: "PT-1002", assignedClinicianId: "PR-2002" },
      { id: "PT-1003" },
      { id: "PT-1004", assignedClinicianId: "" },
      { id: "", assignedClinicianId: "PR-2002" },
      {},
      { assignedClinicianId: "PR-2001" }
    ];
    const malformed = [{ id: "PT-1006", assignedClinicianId: 2002 }, { id: 1001, assignedClinicianId: "PR-2001" }];
    const cases = (objects: Record<string, unknown>[]) => ({ typeName: "hospital.Patient", policyNames: ["hospital.read-patient", "hospital.staff-only"], subjects, objects });

    it("finds no violation, with or without the assertion, on well-typed data", async () => {
      expect(await checkPlanConformance(engine(), cases(wellTyped))).toEqual([]);
      expect(await checkPlanConformance(engine(true), cases(wellTyped))).toEqual([]);
      expect(await checkPlanConformance(engine(), { typeName: "hospital.Appointment", policyNames: ["hospital.read-appointment"], subjects, objects: [{}] })).toEqual([]);
    });

    it("pinned: mistyped data breaks only the assertion — sound either way, overclaimed only when asserted", async () => {
      expect(await checkPlanConformance(engine(), cases([...wellTyped, ...malformed]))).toEqual([]);
      const asserted = await checkPlanConformance(engine(true), cases([...wellTyped, ...malformed]));
      expect(asserted.length).toBeGreaterThan(0);
      expect(asserted.every((v) => v.violation === "overclaimed-exactness" && v.object! >= wellTyped.length)).toBe(true);
    });
  });
});

describe("Cedar planning in the runtime (ADR-0039)", () => {
  const identities: Record<string, Identity> = {
    ...hospitalDemoIdentities,
    admin: { subjectId: "adm", roles: ["admin"], attributes: {} },
    noProvider: { subjectId: "c-none", roles: ["clinician"], attributes: {} },
    malformed: { subjectId: "c-bad", roles: ["clinician"], attributes: { providerId: ["PR-2001"] } }
  };
  const QUERIES: SemanticQuery[] = [
    { type: "hospital.Patient" },
    { type: "hospital.Patient", sort: [{ property: "name" }], limit: 1 },
    { type: "hospital.Patient", filter: { property: "name", operator: "icontains", value: "e" } },
    { type: "hospital.Provider", include: [{ relationship: "patients" }] },
    { type: "hospital.Appointment", include: [{ relationship: "patient" }] }
  ];
  const EXTRA = [
    { objectId: "PT-1003", values: { id: "PT-1003", name: "Second", medicalRecordNumber: "MRN-1003", assignedClinicianId: "PR-2001" } },
    { objectId: "PT-1004", values: { id: "PT-1004", name: "Unassigned", medicalRecordNumber: "MRN-1004" } }
  ];
  async function world(e: PolicyEngine) {
    const tb = await buildHospitalTestbed();
    tb.adapter.seed("hospital.Patient", EXTRA);
    return new SemanticRuntime(tb.registry, [tb.adapter], e);
  }
  async function walk(runtime: SemanticRuntime, query: SemanticQuery, who: Identity) {
    const items: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await runtime.query({ ...query, cursor }, who);
      items.push(...page.items.map((i) => JSON.stringify(i)));
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  it("planning changes no result: Cedar planned, Cedar unplanned, and ABAC planned all return the same objects", async () => {
    const abac = await buildHospitalTestbed().then((tb) => (tb.adapter.seed("hospital.Patient", EXTRA), tb.runtime));
    const [planned, conformant, unplanned] = [await world(engine()), await world(engine(true)), await world(withoutPlanner(engine()))];
    for (const who of Object.values(identities)) {
      for (const query of QUERIES) {
        const expected = await walk(unplanned, query, who);
        expect(await walk(planned, query, who)).toEqual(expected);
        expect(await walk(conformant, query, who)).toEqual(expected);
        if (who !== identities.malformed) expect(await walk(abac, query, who)).toEqual(expected); // ABAC reads role-level Types for a malformed claim (ADR-0031)
      }
    }
  }, 60_000); // exhaustive by design: four runtimes, every identity and query, walked page by page

  it("a clinician's aggregate: refused without the assertion, and equal to ABAC's with it", async () => {
    const count = { type: "hospital.Patient", aggregations: [{ name: "n", op: "count" as const }] };
    const clinician = identities.clinician!;
    await expect((await world(engine())).aggregate(count, clinician)).rejects.toBeInstanceOf(AuthorizationError);
    const conformant = await (await world(engine(true))).aggregate(count, clinician);
    const abac = await buildHospitalTestbed().then((tb) => (tb.adapter.seed("hospital.Patient", EXTRA), tb.runtime.aggregate(count, clinician)));
    expect(conformant).toEqual(abac);
    expect(conformant.groups[0]!.values.n).toBe(2);
  });

  it("the explain report names why a Cedar plan isn't exact", async () => {
    const report = await (await world(engine())).explainQuery({ type: "hospital.Patient" }, identities.clinician!);
    expect(report.plan).toMatchObject({ kind: "predicate", exact: false, limitations: [{ code: "unverified-attribute-types", typeName: "hospital.Patient" }] });
    expect(report.guarantees).toMatchObject({ exact: false, aggregationSafe: false, postFilterRequired: true });
  });

  it("the airforce domain, whose Types declare no attributes, plans exactly under Cedar", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const runtime = new SemanticRuntime(tb.registry, [tb.inMemoryAdapter, tb.mockRestAdapter], engine());
    const plans: AuthorizationPlan[] = [];
    for (const subject of [{ subjectId: "m", roles: ["maintainer"], attributes: {} }, { subjectId: "a", roles: [], attributes: {} }]) {
      plans.push((await runtime.explainQuery({ type: "airforce.Aircraft" }, subject)).plan);
    }
    expect(plans).toEqual([ALWAYS, NEVER]);
  });
});

describe("Cedar under HIGH_ASSURANCE_V1 (ADR-0046)", () => {
  const profile = { securityProfile: HIGH_ASSURANCE_V1 };
  const clinician = hospitalDemoIdentities.clinician;
  const count = { type: "hospital.Patient", aggregations: [{ name: "n", op: "count" as const }] };
  async function world(e: CedarPolicyEngine) {
    const tb = await buildHospitalTestbed();
    return new SemanticRuntime(tb.registry, [tb.adapter], e, profile);
  }

  it("the profile never asserts schema conformance: without the operator's assertion, a Cedar query on an attribute-bearing Type is refused", async () => {
    await expect((await world(engine())).query({ type: "hospital.Patient" }, clinician)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await (await world(engine(true))).query({ type: "hospital.Patient" }, clinician)).items.map((i) => i.objectId)).toEqual(["PT-1001"]);
    // A Type with no declared attributes plans exactly either way.
    expect((await (await world(engine())).query({ type: "hospital.Provider" }, clinician)).items.length).toBeGreaterThan(0);
  });

  it("attack: an exact Cedar plan still can't admit an aggregate — partial evaluation isn't structural — while reads use it", async () => {
    const runtime = await world(engine(true));
    await expect(runtime.aggregate(count, clinician)).rejects.toThrow(/was not derived structurally/);
    const abac = await buildHospitalTestbed().then((tb) => new SemanticRuntime(tb.registry, [tb.adapter], tb.policyEngine, profile));
    expect((await abac.aggregate(count, clinician)).groups[0]!.values.n).toBe(1);
  });
});
