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

  it("only askPlanner() asks the policy engine for a plan (ADR-0038)", () => {
    expect(callSites("this.policyEngine.plan(")).toEqual(["returned = await this.policyEngine.plan(request);"]);
  });

  it("a plan is acted on only by query, aggregate, and explainQuery — each audits what it did with it", () => {
    expect(callSites("this.planRead(")).toEqual([
      "const plan = await this.planRead(typeDef, identity);",
      "const plan = await this.planRead(typeDef, identity);",
      "const plan = await this.planRead(typeDef, identity);"
    ]);
  });

  it("only classify() asks the classification scheme (ADR-0041)", () => {
    expect(callSites("this.classification.join(")).toEqual(["const answer: unknown = this.classification.join(marked);"]);
    expect(callSites("this.classification.decide(")).toEqual([
      "const joined = this.classification.decide({ subject: identity, markings: label, context });",
      "const each = this.classification.decide({ subject: identity, markings: [marking], context });"
    ]);
  });

  it("classify() is called by clearedFor(), which audits, and by default-search planning, which decides no access", () => {
    expect(callSites("this.classify(")).toEqual([
      "const { allow, label, reason } = this.classify(identity, marked, resource, action);",
      'return declared.filter((p) => !computed.has(p) && !gated.has(p) && this.classify(identity, memberMarkings(typeDef, p), { typeName: typeDef.name, propertyPath: p }, "read").allow);'
    ]);
  });
});
