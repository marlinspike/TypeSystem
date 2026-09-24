import { describe, it, expect } from "vitest";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Identity } from "../src/model/policy.js";

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
