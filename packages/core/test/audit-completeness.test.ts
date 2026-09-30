import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * A tripwire for audit completeness (ADR-0030, ADR-0032). The runtime's
 * decision primitives — asking the policy engine, and comparing a clearance
 * with a marking — do not audit; every decision a caller can see must go
 * through `evaluate` or `clearedFor`, which do. `listActions` once called the
 * primitives directly, so its decisions went unaudited. This test pins every
 * call site, so a new one fails here and gets looked at instead of slipping in.
 */
const runtime = readFileSync(new URL("../src/runtime/runtime.ts", import.meta.url), "utf8");
const callSites = (call: string) =>
  runtime
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(call) && !line.startsWith("*") && !line.startsWith("//"));

describe("audit completeness: the non-auditing decision primitives stay behind their audited wrappers", () => {
  it("only decide() asks the policy engine", () => {
    expect(callSites("this.policyEngine.evaluate(")).toEqual(["decision = await this.policyEngine.evaluate(request);"]);
  });

  it("only evaluate() calls decide(), and evaluate() always audits", () => {
    expect(callSites("this.decide(")).toEqual(["const decision = await this.decide({ subject: identity, action, policyName, resource });"]);
  });

  it("only dominates() asks the classification scheme", () => {
    expect(callSites("this.classification.dominates(")).toEqual(["return this.classification.dominates(identity.clearance, marking) === true;"]);
  });

  it("dominates() is called by clearedFor(), which audits, and by default-search planning, which decides no access", () => {
    expect(callSites("this.dominates(")).toEqual([
      "const allow = marked.every((m) => this.dominates(identity, m));",
      "return declared.filter((p) => !computed.has(p) && !gated.has(p) && this.dominates(identity, memberMarking(typeDef, p)));"
    ]);
  });
});
