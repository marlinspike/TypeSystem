import { describe, expect, it } from "vitest";
import { comparePolicies, compilePolicy, type PolicyExpression } from "../src/index.js";

describe("P8 comparePolicies exactness", () => {
  it("P8-M5: a widening through an attribute named __proto__ is real at run time but not reported", async () => {
    const before: PolicyExpression = { role: ["admin"] };
    const after: PolicyExpression = { anyOf: [{ role: ["admin"] }, { attributeMatch: { resource: "ownerId", subject: "__proto__" } }] };
    // A real request the new rule admits and the old refused: subject attributes parsed from JSON claims hold an own "__proto__".
    const subject = { subjectId: "s", roles: [], attributes: JSON.parse('{"__proto__":"u-1"}') as Record<string, string> };
    const request = { subject, action: "read" as const, policyName: "p", resource: { typeName: "T", objectId: "o", attributes: { ownerId: "u-1" } } };
    expect((await compilePolicy(after)(request)).allow).toBe(true);
    expect((await compilePolicy(before)(request)).allow).toBe(false);
    const r = await comparePolicies(before, after);
    expect(r.widens.length).toBeGreaterThan(0);
  });

  it("P8-M5b: same for a resource attribute named __proto__", async () => {
    const before: PolicyExpression = { role: ["admin"] };
    const after: PolicyExpression = { anyOf: [{ role: ["admin"] }, { resourceValue: { attribute: "__proto__", equals: "public" } }] };
    const request = { subject: { subjectId: "s", roles: [], attributes: {} }, action: "read" as const, policyName: "p", resource: { typeName: "T", objectId: "o", attributes: JSON.parse('{"__proto__":"public"}') as Record<string, string> } };
    expect((await compilePolicy(after)(request)).allow).toBe(true);
    const r = await comparePolicies(before, after);
    expect(r.widens.length).toBeGreaterThan(0);
  });
});
