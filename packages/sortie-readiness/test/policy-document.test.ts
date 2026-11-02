import { describe, it, expect } from "vitest";
import { allOf, comparePolicyRules, requireAttributeMatch, requireRole, type Identity, type PolicyRule } from "@typesys/core";
import { opsPolicyRules } from "../src/model.js";

/** ADR-0100: the sortie rules, rewritten as data, decide exactly as the code they replaced. */
const before: Record<string, PolicyRule> = {
  "ops.read": requireRole("planner", "maintainer", "viewer"),
  "ops.maintenance": requireRole("planner", "maintainer"),
  "ops.crew": requireRole("planner", "maintainer"),
  "ops.planner": allOf(requireRole("planner"), requireAttributeMatch("unit", "unit")),
  "ops.sortie-signoff": requireRole("planner")
};
const roles = [[], ["planner"], ["maintainer"], ["viewer"]];
const subjects: Identity[] = roles.flatMap((r, i) => [
  { subjectId: `s${i}`, roles: r, attributes: { unit: "555 FS" } },
  { subjectId: `t${i}`, roles: r, attributes: {} }
]);
const resources = [{ typeName: "ops.Sortie" }, { typeName: "ops.Sortie", objectId: "1", attributes: { unit: "555 FS" } }, { typeName: "ops.Sortie", objectId: "2", attributes: { unit: "510 FS" } }];
const requests = subjects.flatMap((subject) => resources.map((resource) => ({ subject, action: "read" as const, resource })));

describe("sortie policies as data (ADR-0100)", () => {
  it("decide, explain and plan exactly as the code did", async () => {
    expect(await comparePolicyRules(before, opsPolicyRules, requests)).toEqual([]);
  });
});
