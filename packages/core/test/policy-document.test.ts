import { describe, it, expect } from "vitest";
import {
  AbacPolicyEngine,
  allOf,
  allowAllRule,
  anyOf,
  describeRule,
  requireAttributeMatch,
  requireResourceValue,
  requireRole,
  type PolicyRule
} from "../src/policy/abac-policy-engine.js";
import { compilePolicies, compilePolicy, PolicyDocumentError, validatePolicyExpression, type PolicyExpression } from "../src/policy/policy-document.js";
import { comparePolicyRules } from "../src/testing/policy-parity.js";
import type { Identity, PolicyRequest } from "../src/model/policy.js";

/** ADR-0100: policy rules written as data compile to exactly the combinators they name. */

const who = (roles: string[], attributes: Record<string, unknown> = {}): Identity => ({ subjectId: `s-${roles.join("-")}`, roles, attributes });
const subjects = [who([]), who(["maintainer"], { displayName: "Kim" }), who(["maintainer", "lead"]), who(["viewer"]), who(["carrier"], { carrier: "Northline" }), who(["qa"]), who(["logistics"])];
const resources = [
  { typeName: "t.T" },
  { typeName: "t.T", objectId: "1", attributes: { assignedTo: "Kim", carrier: "Northline", embargoed: false } },
  { typeName: "t.T", objectId: "2", attributes: { assignedTo: "Lee", carrier: "Polar", embargoed: true } },
  { typeName: "t.T", objectId: "3", attributes: {} }
];
const requests: Omit<PolicyRequest, "policyName">[] = subjects.flatMap((subject) => resources.map((resource) => ({ subject, action: "read" as const, resource })));

describe("policies as data (ADR-0100)", () => {
  it("every form compiles to the combinator it names: same decisions, reasons, plans and description", async () => {
    const code: Record<string, PolicyRule> = {
      always: allowAllRule,
      role: requireRole("maintainer", "viewer"),
      match: requireAttributeMatch("assignedTo", "displayName"),
      value: requireResourceValue("carrier", "Northline"),
      nested: anyOf(requireRole("lead"), allOf(requireRole("maintainer"), requireAttributeMatch("assignedTo", "displayName"))),
      public: allOf(requireRole("logistics", "qa"), requireResourceValue("embargoed", false, { typeLevel: "allow", reason: "embargoed" }))
    };
    const data = compilePolicies({
      always: "always",
      role: { role: ["maintainer", "viewer"] },
      match: { attributeMatch: { resource: "assignedTo", subject: "displayName" } },
      value: { resourceValue: { attribute: "carrier", equals: "Northline" } },
      nested: { anyOf: [{ role: ["lead"] }, { allOf: [{ role: ["maintainer"] }, { attributeMatch: { resource: "assignedTo", subject: "displayName" } }] }] },
      public: { allOf: [{ role: ["logistics", "qa"] }, { resourceValue: { attribute: "embargoed", equals: false, typeLevel: "allow", reason: "embargoed" } }] }
    });
    expect(await comparePolicyRules(code, data, requests)).toEqual([]);
  });

  it("the parity check sees a difference in decision, reason, plan or description", async () => {
    const diffs = await comparePolicyRules({ p: requireRole("maintainer") }, { p: requireRole("maintainer", "viewer") }, requests);
    expect(new Set(diffs.map((d) => d.what))).toEqual(new Set(["description", "decision", "reason", "plan"]));
    expect(await comparePolicyRules({ p: requireRole("a") }, {}, requests)).toEqual([{ policy: "p", request: -1, what: "missing", before: true, after: false }]);
  });

  it("compiled rules keep their structural plan assurance (ADR-0046)", () => {
    const engine = new AbacPolicyEngine();
    for (const [name, rule] of Object.entries(compilePolicies({ a: { anyOf: [{ role: ["x"] }, { resourceValue: { attribute: "k", equals: true } }] } }))) engine.registerRule(name, rule);
    expect(engine.planAssurance({ subject: who(["x"]), action: "read", policyName: "a", resource: { typeName: "t.T" } })).toBe("structural");
  });

  describe("requireResourceValue", () => {
    const req = (attributes?: Record<string, unknown>): PolicyRequest => ({ subject: who([]), action: "read", policyName: "p", resource: { typeName: "t.T", ...(attributes ? { objectId: "1", attributes } : {}) } });

    it("compares strictly, on the resource's own attribute only", async () => {
      const rule = requireResourceValue("embargoed", false);
      expect((await rule(req({ embargoed: false }))).allow).toBe(true);
      expect((await rule(req({ embargoed: 0 }))).allow).toBe(false);
      expect((await rule(req({ embargoed: "false" }))).allow).toBe(false);
      expect((await rule(req({}))).allow).toBe(false);
      const inherited = Object.create({ embargoed: false }) as Record<string, unknown>;
      expect((await rule(req(inherited))).allow).toBe(false);
    });

    it("denies a type-level request unless told some instances are readable", async () => {
      expect((await requireResourceValue("embargoed", false)(req())).allow).toBe(false);
      expect((await requireResourceValue("embargoed", false, { typeLevel: "allow" })(req())).allow).toBe(true);
    });

    it("plans the objects holding an identifier, and nothing it cannot say for a boolean", async () => {
      const plan = (rule: PolicyRule) => (rule as unknown as { plan(r: PolicyRequest): unknown }).plan(req());
      expect(await plan(requireResourceValue("carrier", "Northline"))).toMatchObject({ kind: "predicate", predicate: { attribute: "carrier", eq: "Northline" }, exact: true });
      expect(await plan(requireResourceValue("embargoed", false))).toMatchObject({ kind: "unknown", limitations: [{ code: "unrepresentable-condition", policyName: "p" }] });
    });

    it("never quotes the value in a deny reason, and describes itself", async () => {
      const decision = await requireResourceValue("level", "SECRET-ish")(req({ level: "other" }));
      expect(decision.reason).not.toContain("SECRET-ish");
      expect(describeRule(requireResourceValue("embargoed", false, { typeLevel: "allow" }))).toBe("resource.embargoed = false (any instance may be, at type level)");
    });
  });

  describe("a malformed document is refused with every problem named", () => {
    const bad: [string, unknown, string][] = [
      ["a number", 3, "policy: must be"],
      ["no form", {}, "must have exactly one of"],
      ["two forms", { role: ["a"], anyOf: [{ role: ["b"] }] }, "has role, anyOf"],
      ["an unknown field", { role: ["a"], note: "x" }, 'unknown field "note"'],
      ["empty roles", { role: [] }, "non-empty list of role names"],
      ["a blank role", { role: [""] }, "non-empty list of role names"],
      ["an empty anyOf", { anyOf: [] }, "non-empty list of policies"],
      ["a match missing its subject", { attributeMatch: { resource: "a" } }, "attributeMatch.subject"],
      ["an extra match field", { attributeMatch: { resource: "a", subject: "b", via: "c" } }, 'unknown field "via"'],
      ["a value with no equals", { resourceValue: { attribute: "a" } }, "resourceValue.equals"],
      ["an object as the value", { resourceValue: { attribute: "a", equals: { $ne: 1 } } }, "resourceValue.equals"],
      ["an infinite value", { resourceValue: { attribute: "a", equals: Infinity } }, "resourceValue.equals"],
      ["a bad typeLevel", { resourceValue: { attribute: "a", equals: 1, typeLevel: "maybe" } }, "typeLevel"],
      ["a nested problem", { anyOf: [{ role: ["a"] }, { allOf: [{ role: 7 }] }] }, "policy.anyOf[1].allOf[0].role"]
    ];
    for (const [what, expr, message] of bad)
      it(`refuses ${what}`, () => {
        expect(validatePolicyExpression(expr).join("\n")).toContain(message);
        expect(() => compilePolicy(expr as PolicyExpression)).toThrow(PolicyDocumentError);
      });

    it("refuses a document nested deep enough to exhaust the stack", () => {
      let expr: unknown = { role: ["a"] };
      for (let i = 0; i < 100_000; i++) expr = { anyOf: [expr] };
      expect(validatePolicyExpression(expr).join()).toContain("nested more than 32 levels deep");
    });

    it("reports every bad rule of a document at once, by name", () => {
      try {
        compilePolicies({ a: { role: [] }, b: "never" as unknown as PolicyExpression, c: { role: ["ok"] } });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyDocumentError);
        const problems = (err as PolicyDocumentError).problems;
        expect(problems).toHaveLength(2);
        expect(problems[0]).toContain('policies["a"]');
        expect(problems[1]).toContain('policies["b"]');
      }
    });
  });
});
