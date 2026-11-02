import { describe, it, expect } from "vitest";
import { allOf, anyOf, comparePolicyRules, requireAttributeMatch, requireRole, type Identity, type PolicyRule } from "@typesys/core";
import { airforcePolicyRules } from "../src/setup.js";

/** ADR-0100: the airforce rules, rewritten as data, decide exactly as the code they replaced. */
const before: Record<string, PolicyRule> = {
  "airforce.read-aircraft": requireRole("maintainer", "viewer", "ai-enclave"),
  "airforce.maintainer-only": requireRole("maintainer", "ai-enclave"),
  "airforce.work-order-assignee": allOf(requireRole("maintainer"), anyOf(requireRole("lead"), requireAttributeMatch("assignedTo", "displayName"))),
  "airforce.maintenance-lead": allOf(requireRole("maintainer"), requireRole("lead")),
  "airforce.inspect": requireRole("lead")
};
const roles = [[], ["maintainer"], ["viewer"], ["lead"], ["maintainer", "lead"], ["ai-enclave"]];
const subjects: Identity[] = roles.flatMap((r, i) => [
  { subjectId: `s${i}`, roles: r, attributes: { displayName: "SSgt Rivera" } },
  { subjectId: `t${i}`, roles: r, attributes: {} }
]);
const resources = [
  { typeName: "airforce.WorkOrder" },
  { typeName: "airforce.WorkOrder", objectId: "W1", attributes: { assignedTo: "SSgt Rivera" } },
  { typeName: "airforce.WorkOrder", objectId: "W2", attributes: { assignedTo: "TSgt Okafor" } }
];
const requests = subjects.flatMap((subject) => resources.map((resource) => ({ subject, action: "read" as const, resource })));

describe("airforce policies as data (ADR-0100)", () => {
  it("decide, explain and plan exactly as the code did", async () => {
    expect(await comparePolicyRules(before, airforcePolicyRules, requests)).toEqual([]);
  });
});
