import { describe, expect, it } from "vitest";
import { AbacPolicyEngine, allOf, allowAllRule, anyOf, describeRule, requireAttributeMatch, requireRole, type PolicyRule } from "../src/index.js";

describe("policy descriptions (ADR-0088)", () => {
  it("describes each combinator from the arguments it was built with", () => {
    expect(describeRule(requireRole("a", "b"))).toBe("role in [a, b]");
    expect(describeRule(requireAttributeMatch("owner", "id"))).toBe("resource.owner = subject.id");
    expect(describeRule(allowAllRule)).toBe("always");
    expect(describeRule(allOf(requireRole("m"), anyOf(requireRole("lead"), requireAttributeMatch("assignedTo", "displayName"))))).toBe("all of (role in [m]; any of (role in [lead]; resource.assignedTo = subject.displayName))");
  });

  it("calls a plain function rule opaque, inside a combinator too", () => {
    const opaque: PolicyRule = () => ({ allow: true });
    expect(describeRule(opaque)).toBe("opaque rule (a function)");
    expect(describeRule(anyOf(requireRole("x"), opaque))).toBe("any of (role in [x]; opaque rule (a function))");
  });

  it("the engine describes what is registered, says an unregistered policy denies, and returns nothing for a function rule", () => {
    const engine = new AbacPolicyEngine();
    engine.registerRule("r", requireRole("x"));
    engine.registerRule("f", () => ({ allow: false }));
    expect(engine.describe("r")).toBe("role in [x]");
    expect(engine.describe("missing")).toBe("not registered: denies every request");
    expect(engine.describe("f")).toBeUndefined();
  });
});
