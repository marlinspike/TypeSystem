import { describe, it, expect } from "vitest";
import { AbacPolicyEngine, allOf, allowAllRule, anyOf, requireAttributeMatch, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import type { Identity, PolicyDecision, PolicyRequest } from "../src/model/policy.js";

const maintainer: Identity = { subjectId: "u-maintainer", roles: ["maintainer"], attributes: {} };
const viewer: Identity = { subjectId: "u-viewer", roles: ["viewer"], attributes: {} };

describe("AbacPolicyEngine", () => {
  it("allows when the subject has a required role", async () => {
    const engine = new AbacPolicyEngine();
    engine.registerRule("maintainer-only", requireRole("maintainer"));

    const decision = await engine.evaluate({
      subject: maintainer,
      action: "invoke",
      policyName: "maintainer-only",
      resource: { typeName: "airforce.Aircraft", actionName: "CreateMaintenanceWorkOrder" }
    });
    expect(decision.allow).toBe(true);
  });

  it("denies when the subject lacks the required role", async () => {
    const engine = new AbacPolicyEngine();
    engine.registerRule("maintainer-only", requireRole("maintainer"));

    const decision = await engine.evaluate({
      subject: viewer,
      action: "invoke",
      policyName: "maintainer-only",
      resource: { typeName: "airforce.Aircraft", actionName: "CreateMaintenanceWorkOrder" }
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/Requires one of roles/);
  });

  it("fails closed for an unregistered policy name", async () => {
    const engine = new AbacPolicyEngine();
    const decision = await engine.evaluate({
      subject: viewer,
      action: "read",
      policyName: "no-such-policy",
      resource: { typeName: "airforce.Aircraft" }
    });
    expect(decision.allow).toBe(false);
  });

  it("allowAllRule always allows", async () => {
    const engine = new AbacPolicyEngine();
    engine.registerRule("public", allowAllRule);
    const decision = await engine.evaluate({
      subject: viewer,
      action: "read",
      policyName: "public",
      resource: { typeName: "airforce.Aircraft" }
    });
    expect(decision.allow).toBe(true);
  });
});

function instanceRequest(subjectAttributes: Record<string, unknown>, attributes?: Record<string, unknown>, roles: string[] = []): PolicyRequest {
  return {
    subject: { subjectId: "s", roles, attributes: subjectAttributes },
    action: "read",
    policyName: "p",
    resource: { typeName: "t.T", objectId: "o1", ...(attributes ? { attributes: Object.freeze({ ...attributes }) } : {}) }
  };
}

describe("row-level rule helpers (ADR-0030)", () => {
  const owns = requireAttributeMatch("ownerId", "userId");

  it("requireAttributeMatch allows when the resource and subject attributes are the same identifier", async () => {
    expect((await owns(instanceRequest({ userId: "u1" }, { ownerId: "u1" }))).allow).toBe(true);
    expect((await owns(instanceRequest({ userId: 42 }, { ownerId: 42 }))).allow).toBe(true);
  });

  it("requireAttributeMatch denies a mismatch, and names the attributes but never their values", async () => {
    const decision = await owns(instanceRequest({ userId: "u1" }, { ownerId: "u-secret" }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("Requires resource.ownerId to match subject.userId");
    expect(decision.reason).not.toMatch(/u1|u-secret/);
  });

  it("requireAttributeMatch denies a type-level request, which has no attributes to match", async () => {
    expect((await owns(instanceRequest({ userId: "u1" }))).allow).toBe(false);
  });

  it("requireAttributeMatch never treats two missing or unusable values as a match", async () => {
    const unusable: unknown[] = [undefined, null, "", Number.NaN, Infinity, ["u1"], { id: "u1" }, true];
    for (const v of unusable) {
      expect((await owns(instanceRequest({ userId: v }, { ownerId: v }))).allow).toBe(false);
    }
    expect((await owns(instanceRequest({}, {}))).allow).toBe(false);
    expect((await owns(instanceRequest({ userId: "1" }, { ownerId: 1 }))).allow).toBe(false); // no coercion
  });

  it("requireAttributeMatch reads only own properties, never inherited ones", async () => {
    const byConstructor = requireAttributeMatch("constructor", "constructor");
    expect((await byConstructor(instanceRequest({}, {}))).allow).toBe(false);
    const inherited = Object.create({ ownerId: "u1" }) as Record<string, unknown>;
    const request = instanceRequest({ userId: "u1" });
    request.resource.attributes = inherited;
    expect((await owns(request)).allow).toBe(false);
  });

  it("anyOf allows on the first allowing rule and otherwise denies with every reason", async () => {
    const rule = anyOf(requireRole("admin"), owns);
    expect((await rule(instanceRequest({}, {}, ["admin"]))).allow).toBe(true);
    expect((await rule(instanceRequest({ userId: "u1" }, { ownerId: "u1" }))).allow).toBe(true);
    const denied = await rule(instanceRequest({ userId: "u1" }, { ownerId: "u2" }));
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("Requires one of roles [admin]");
    expect(denied.reason).toContain("Requires resource.ownerId to match subject.userId");
  });

  it("allOf allows only when every rule allows, and denies with the first denying rule's reason", async () => {
    const rule = allOf(requireRole("clinician"), owns);
    expect((await rule(instanceRequest({ userId: "u1" }, { ownerId: "u1" }, ["clinician"]))).allow).toBe(true);
    expect((await rule(instanceRequest({ userId: "u1" }, { ownerId: "u1" }))).reason).toMatch(/Requires one of roles \[clinician\]/);
    expect((await rule(instanceRequest({ userId: "u1" }, { ownerId: "u2" }, ["clinician"]))).reason).toMatch(/ownerId/);
  });

  it("the combinators refuse an empty rule list rather than allow or deny by accident", () => {
    expect(() => anyOf()).toThrow(TypeError);
    expect(() => allOf()).toThrow(TypeError);
  });

  it("the combinators treat only an explicit allow: true as allowing", async () => {
    const truthy: PolicyRule = () => ({ allow: "yes" } as unknown as PolicyDecision);
    expect((await anyOf(truthy)(instanceRequest({}))).allow).toBe(false);
    expect((await allOf(truthy)(instanceRequest({}))).allow).toBe(false);
  });
});
