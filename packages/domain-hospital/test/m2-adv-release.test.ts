import { describe, it, expect } from "vitest";
import { AuthorizationError, withAudience, type Audience, type Identity } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

/**
 * ADR-0067 adversarial: what a refusal tells the model. The model is the
 * party the release boundary protects against; a refusal it receives must
 * not reveal anything about a row it may not read.
 */
const { clinician } = hospitalDemoIdentities; // provider PR-2001; PT-1001 is assigned to PR-2001, PT-1002 to PR-2002
const otherTeamModel: Audience = { id: "model:team-PR-2002", kind: "model", roles: ["clinician"], attributes: { providerId: "PR-2002" } };

async function reason(who: Identity, id: string): Promise<string> {
  const { runtime } = await buildHospitalTestbed();
  try {
    await runtime.getObject("hospital.Patient", id, who);
    return "allowed";
  } catch (err) {
    if (err instanceof AuthorizationError) return err.reason ?? err.message;
    throw err;
  }
}

describe("m2-adv: refusal reasons for an audience (ADR-0067)", () => {
  it("the model cannot tell, from the refusal, which patients exist and are assigned to its user", async () => {
    const agent = withAudience(clinician, otherTeamModel);
    const assigned = await reason(agent, "PT-1001");
    const notAssigned = await reason(agent, "PT-1002");
    const missing = await reason(agent, "PT-9999");
    // Every one is refused...
    expect([assigned, notAssigned, missing].includes("allowed")).toBe(false);
    // ...and secure refusals are indistinguishable. Observed: only the assigned, existing patient reads "Not releasable to ...".
    expect(new Set([assigned, notAssigned, missing]).size).toBe(1);
  });
});
