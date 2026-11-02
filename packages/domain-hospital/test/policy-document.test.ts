import { describe, it, expect } from "vitest";
import { allOf, allowAllRule, anyOf, comparePolicyRules, requireAttributeMatch, requireRole, type Identity, type PolicyRule } from "@typesys/core";
import { hospitalPolicyRules } from "../src/setup.js";

/** ADR-0100: the hospital rules, rewritten as data, decide exactly as the code they replaced. */
const before: Record<string, PolicyRule> = {
  "hospital.read-provider": allowAllRule,
  "hospital.read-patient": anyOf(
    requireRole("admin"),
    allOf(requireRole("clinician"), requireAttributeMatch("assignedClinicianId", "providerId")),
    allOf(requireRole("patient"), requireAttributeMatch("id", "patientId"))
  ),
  "hospital.read-appointment": requireRole("clinician", "admin", "patient"),
  "hospital.staff-only": requireRole("clinician", "admin")
};
const roles = [[], ["admin"], ["clinician"], ["patient"], ["clinician", "patient"]];
const subjects: Identity[] = roles.flatMap((r, i) => [
  { subjectId: `s${i}`, roles: r, attributes: { providerId: "prov-1", patientId: "pat-1" } },
  { subjectId: `t${i}`, roles: r, attributes: { providerId: 7 } }
]);
const resources = [
  { typeName: "hospital.Patient" },
  { typeName: "hospital.Patient", objectId: "pat-1", attributes: { id: "pat-1", assignedClinicianId: "prov-1" } },
  { typeName: "hospital.Patient", objectId: "pat-2", attributes: { id: "pat-2", assignedClinicianId: 7 } }
];
const requests = subjects.flatMap((subject) => resources.map((resource) => ({ subject, action: "read" as const, resource })));

describe("hospital policies as data (ADR-0100)", () => {
  it("decide, explain and plan exactly as the code did", async () => {
    expect(await comparePolicyRules(before, hospitalPolicyRules, requests)).toEqual([]);
  });
});
