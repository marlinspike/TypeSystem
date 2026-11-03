import { describe, expect, it } from "vitest";
import { comparePolicies, describeWitness, PolicyTooLargeError } from "../src/policy/policy-diff.js";
import type { PolicyExpression } from "../src/policy/policy-document.js";

/** ADR-0109: what a policy change admits, decided exactly, with a witness. */
describe("comparePolicies", () => {
  it("finds no change between equal rules written differently", async () => {
    const a: PolicyExpression = { role: ["a", "b"] };
    const b: PolicyExpression = { anyOf: [{ role: ["b"] }, { role: ["a"] }] };
    expect(await comparePolicies(a, b)).toEqual({ widens: [], narrows: [] });
  });

  it("finds a role no persona holds: the case persona sampling misses", async () => {
    const r = await comparePolicies({ role: ["maintainer"] }, { role: ["maintainer", "contractor"] });
    expect(r.widens.map((w) => w.roles)).toEqual([["contractor"]]);
    expect(r.narrows).toEqual([]);
    expect(describeWitness(r.widens[0]!)).toContain("role contractor");
  });

  it("finds a dropped conjunct, and the narrowing the other way", async () => {
    const before: PolicyExpression = { allOf: [{ role: ["maintainer"] }, { attributeMatch: { resource: "assignedTo", subject: "displayName" } }] };
    const after: PolicyExpression = { role: ["maintainer"] };
    const r = await comparePolicies(before, after);
    expect(r.widens).toHaveLength(1);
    expect(describeWitness(r.widens[0]!)).toBe("a subject with role maintainer, on any object and in lists");
    const back = await comparePolicies(after, before);
    expect(back.widens).toEqual([]);
    expect(back.narrows.length).toBeGreaterThan(0);
  });

  it("decides an attribute match exactly: a different attribute is a widening, the same one is not", async () => {
    const own: PolicyExpression = { attributeMatch: { resource: "assignedClinicianId", subject: "providerId" } };
    expect((await comparePolicies(own, { anyOf: [own, { allOf: [own, { role: ["x"] }] }] })).widens).toEqual([]);
    const other = await comparePolicies(own, { attributeMatch: { resource: "attendingId", subject: "providerId" } });
    expect(other.widens).toHaveLength(1);
    expect(describeWitness(other.widens[0]!)).toContain("attendingId matches the subject's");
  });

  it("treats type level as its own request: allowing it is a widening", async () => {
    const deny: PolicyExpression = { resourceValue: { attribute: "embargoed", equals: false } };
    const allow: PolicyExpression = { resourceValue: { attribute: "embargoed", equals: false, typeLevel: "allow" } };
    const r = await comparePolicies(deny, allow);
    expect(r.widens.map((w) => w.resource)).toEqual(["type-level"]);
  });

  it("removing an embargo condition is a widening on the embargoed objects", async () => {
    const before: PolicyExpression = { anyOf: [{ role: ["qa"] }, { allOf: [{ role: ["logistics"] }, { resourceValue: { attribute: "embargoed", equals: false, typeLevel: "allow" } }] }] };
    const after: PolicyExpression = { role: ["qa", "logistics"] };
    const r = await comparePolicies(before, after);
    expect(r.widens.every((w) => w.roles.join() === "logistics")).toBe(true);
    expect(r.widens.some((w) => w.resource !== "type-level")).toBe(true);
  });

  it("skips contradictory conjunctions rather than reporting a request nobody can make", async () => {
    const after: PolicyExpression = { allOf: [{ resourceValue: { attribute: "s", equals: "a" } }, { resourceValue: { attribute: "s", equals: "b" } }] };
    expect((await comparePolicies({ role: ["nobody"] }, after)).widens).toEqual([]);
    const boolMatch: PolicyExpression = { allOf: [{ resourceValue: { attribute: "x", equals: true } }, { attributeMatch: { resource: "x", subject: "y" } }] };
    expect((await comparePolicies({ role: ["nobody"] }, boolMatch)).widens).toEqual([]);
  });

  it("a fresh value never collides with a literal the old rule names", async () => {
    const before: PolicyExpression = { resourceValue: { attribute: "owner", equals: "v1" } };
    const after: PolicyExpression = { attributeMatch: { resource: "owner", subject: "id" } };
    expect((await comparePolicies(before, after)).widens).toHaveLength(1);
  });

  it("a new rule widens from nothing, a removed one narrows to nothing", async () => {
    expect((await comparePolicies(undefined, "always")).widens.map((w) => w.resource)).toEqual([{ attributes: {} }]);
    expect((await comparePolicies("always", undefined)).narrows).toHaveLength(1);
  });

  it("refuses an expression too large to enumerate", async () => {
    const big: PolicyExpression = { allOf: Array.from({ length: 13 }, (_, i) => ({ role: [`a${i}`, `b${i}`] })) };
    await expect(comparePolicies("always", big)).rejects.toBeInstanceOf(PolicyTooLargeError);
  });
});
