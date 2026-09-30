import { describe, it, expect } from "vitest";
import { AuthorizationError, SemanticRuntime, checkPlanConformance, type Identity, type PolicyEngine, type SemanticQuery } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities, hospitalPolicyRules } from "../src/setup.js";

/**
 * ADR-0038 on a real domain: the hospital's patient policy plans exactly, so
 * a planning runtime must return what a runtime deciding every row returns —
 * for every identity and read path — while its pages come back full and its
 * aggregates span exactly the readable rows.
 */
const EDGE_PATIENTS = [
  { objectId: "PT-1003", values: { id: "PT-1003", name: "Second of 2001", medicalRecordNumber: "MRN-1003", assignedClinicianId: "PR-2001" } },
  { objectId: "PT-1004", values: { id: "PT-1004", name: "Third of 2001", medicalRecordNumber: "MRN-1004", assignedClinicianId: "PR-2001" } },
  { objectId: "PT-1005", values: { id: "PT-1005", name: "Unassigned", medicalRecordNumber: "MRN-1005" } },
  { objectId: "PT-1006", values: { id: "PT-1006", name: "Empty", medicalRecordNumber: "MRN-1006", assignedClinicianId: "" } },
  { objectId: "PT-1007", values: { id: "PT-1007", name: "Numeric", medicalRecordNumber: "MRN-1007", assignedClinicianId: 2001 } },
  { objectId: "PT-1008", values: { id: "PT-1008", name: "Listed", medicalRecordNumber: "MRN-1008", assignedClinicianId: ["PR-2001"] } }
];

const identities: Record<string, Identity> = {
  ...hospitalDemoIdentities,
  admin: { subjectId: "adm", roles: ["admin"], attributes: {} },
  noProvider: { subjectId: "c-none", roles: ["clinician"], attributes: {} },
  emptyProvider: { subjectId: "c-empty", roles: ["clinician"], attributes: { providerId: "" } },
  numericProvider: { subjectId: "c-num", roles: ["clinician"], attributes: { providerId: 2001 } },
  stringNumericProvider: { subjectId: "c-str", roles: ["clinician"], attributes: { providerId: "2001" } },
  clinicianAndPatient: { subjectId: "c-both", roles: ["clinician", "patient"], attributes: { providerId: "PR-2002", patientId: "PT-1004" } },
  providerWithoutRole: { subjectId: "c-norole", roles: [], attributes: { providerId: "PR-2001" } }
};

const withoutPlanner = (engine: PolicyEngine): PolicyEngine => ({ evaluate: (request) => engine.evaluate(request) });

async function worlds() {
  const tb = await buildHospitalTestbed();
  tb.adapter.seed("hospital.Patient", EDGE_PATIENTS);
  return { planned: tb.runtime, postFiltered: new SemanticRuntime(tb.registry, [tb.adapter], withoutPlanner(tb.policyEngine)), tb };
}

/** Every page of a query, walked to the end. */
async function walk(runtime: SemanticRuntime, query: SemanticQuery, who: Identity) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.query({ ...query, cursor }, who);
    pages.push(page.items.map((i) => JSON.stringify(i)));
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

const QUERIES: SemanticQuery[] = [
  { type: "hospital.Patient" },
  { type: "hospital.Patient", sort: [{ property: "name", direction: "desc" }] },
  { type: "hospital.Patient", filter: { property: "name", operator: "icontains", value: "of" } },
  { type: "hospital.Patient", search: { text: "2001", properties: ["name"] } },
  { type: "hospital.Patient", select: ["name"], include: [{ relationship: "appointments" }] },
  { type: "hospital.Provider", include: [{ relationship: "patients" }] },
  { type: "hospital.Appointment", include: [{ relationship: "patient" }] }
];

describe("authorization planning on the hospital domain (ADR-0038)", () => {
  it("the patient policy's planner is sound and exact for every identity and every stored patient", async () => {
    const { tb } = await worlds();
    const { items } = await tb.adapter.queryByType("hospital.Patient", undefined, 1000);
    const violations = await checkPlanConformance(tb.policyEngine, {
      typeName: "hospital.Patient",
      policyNames: Object.keys(hospitalPolicyRules),
      subjects: Object.values(identities),
      objects: items.map((i) => i.values)
    });
    expect(violations).toEqual([]);
  });

  it("planning changes no result: every query, walked page by page, returns the same objects in the same order", async () => {
    const { planned, postFiltered } = await worlds();
    let compared = 0;
    for (const who of Object.values(identities)) {
      for (const query of QUERIES) {
        for (const limit of [1, 2, 100]) {
          const [a, b] = [await walk(planned, { ...query, limit }, who), await walk(postFiltered, { ...query, limit }, who)];
          expect(a.flat()).toEqual(b.flat());
          compared++;
        }
      }
    }
    expect(compared).toBe(Object.keys(identities).length * QUERIES.length * 3);
  }, 60_000); // exhaustive by design: hundreds of paged walks

  it("…and its pages come back full: only the last page may be short", async () => {
    const { planned, postFiltered } = await worlds();
    const clinician = identities.clinician!;
    const pages = await walk(planned, { type: "hospital.Patient", limit: 1 }, clinician);
    expect(pages.map((p) => p.length)).toEqual([1, 1, 1]);
    // Deciding every row, the same walk leaks how many patients sit between the clinician's.
    expect((await walk(postFiltered, { type: "hospital.Patient", limit: 1 }, clinician)).some((p) => p.length === 0)).toBe(true);
    for (const who of Object.values(identities)) {
      const walked = await walk(planned, { type: "hospital.Patient", limit: 2 }, who);
      for (const page of walked.slice(0, -1)) expect(page).toHaveLength(2);
    }
  });

  it("an aggregate spans exactly the patients the caller may read, and is refused only to a subject who can read none", async () => {
    const { planned, postFiltered } = await worlds();
    for (const [name, who] of Object.entries(identities)) {
      const readable = (await walk(postFiltered, { type: "hospital.Patient", limit: 100 }, who)).flat().length;
      const counted = await planned.aggregate({ type: "hospital.Patient", aggregations: [{ name: "n", op: "count" }] }, who).then(
        (r) => r.groups[0]?.values.n,
        (e: unknown) => (e instanceof AuthorizationError ? "refused" : e)
      );
      // `never` — the subject can't read any patient at all — refuses; an exact plan that matches none counts 0.
      const { plan } = await planned.explainQuery({ type: "hospital.Patient" }, who);
      expect([name, counted]).toEqual([name, plan.kind === "never" ? "refused" : readable]);
    }
  });
});
