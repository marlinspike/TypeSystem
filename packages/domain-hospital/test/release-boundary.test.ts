import { describe, it, expect } from "vitest";
import { AuthorizationError, withAudience, type Audience, type Identity, type SemanticQuery } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

/**
 * Row-level release (ADR-0067): with an audience bound, the read policy is
 * planned for the person and the audience and the plans are conjoined, so a
 * page holds only rows both may read, and the pushed-down filter says so.
 */
const { clinician: clinicianA } = hospitalDemoIdentities;
const ids = (items: { objectId: string }[]) => items.map((o) => o.objectId).sort();

/** A model deployed for one clinical team: policy treats it as a clinician of provider `providerId`. */
const teamModel = (providerId: string): Audience => ({ id: `model:team-${providerId}`, kind: "model", roles: ["clinician"], attributes: { providerId } });

async function patients(who: Identity, query: SemanticQuery = { type: "hospital.Patient" }): Promise<string[]> {
  const { runtime } = await buildHospitalTestbed();
  return runtime.query(query, who).then(
    (r) => ids(r.items),
    (err: unknown) => (err instanceof AuthorizationError ? [] : Promise.reject(err as Error))
  );
}

describe("row-level release for an audience (ADR-0067)", () => {
  it("rows both may read: the clinician's own patient for their team's model, none for another team's", async () => {
    expect(await patients(clinicianA)).toEqual(["PT-1001"]);
    expect(await patients(withAudience(clinicianA, teamModel("PR-2001")))).toEqual(["PT-1001"]);
    expect(await patients(withAudience(clinicianA, teamModel("PR-2002")))).toEqual([]);
  });

  it("the plan pushed to the store is the conjunction of both plans", async () => {
    const { runtime } = await buildHospitalTestbed();
    const report = await runtime.explainQuery({ type: "hospital.Patient" }, withAudience(clinicianA, teamModel("PR-2002")));
    const text = JSON.stringify(report);
    expect(text).toContain("PR-2001");
    expect(text).toContain("PR-2002");
  });

  it("a model granted nothing receives no patient, whoever asks", async () => {
    const admin: Identity = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };
    expect(await patients(admin)).toEqual(["PT-1001", "PT-1002"]);
    expect(await patients(withAudience(admin, { id: "model:anything", kind: "model", roles: [], attributes: {} }))).toEqual([]);
  });
});
