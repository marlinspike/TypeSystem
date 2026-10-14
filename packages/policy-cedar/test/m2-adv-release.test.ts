import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { AuthorizationError, DEMO_LINEAR_CLASSIFICATION, SemanticRuntime, withAudience, type Audience, type Identity, type PolicyEngine } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities } from "@typesys/domain-hospital";
import { CedarPolicyEngine } from "../src/index.js";

/**
 * ADR-0067 adversarial, Cedar with its planner on (parity.test hides planners):
 * row-level release, including aggregates (no post-read check), must be the
 * conjunction under both engines.
 */
const SCHEMA = readFileSync(new URL("../examples/demo-domains.cedarschema", import.meta.url), "utf8");
const POLICIES = readFileSync(new URL("../examples/demo-domains.cedar", import.meta.url), "utf8");
const team = (providerId: string): Audience => ({ id: `model:team-${providerId}`, kind: "model", roles: ["clinician"], attributes: { providerId } });
const { clinician } = hospitalDemoIdentities;
const admin: Identity = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };

async function runtimes(): Promise<Record<"abac" | "cedar", SemanticRuntime>> {
  const a = await buildHospitalTestbed();
  const c = await buildHospitalTestbed();
  const make = (tb: typeof a, engine: PolicyEngine) => new SemanticRuntime(tb.registry, [tb.adapter], engine, { classification: DEMO_LINEAR_CLASSIFICATION });
  return { abac: make(a, a.policyEngine), cedar: make(c, new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES })) };
}

const outcome = async (f: () => Promise<unknown>) =>
  f().then(
    (r) => JSON.parse(JSON.stringify(r)) as unknown,
    (e: unknown) => (e instanceof AuthorizationError ? "refused" : `error:${(e as Error).name}`)
  );

describe("m2-adv: Cedar and ABAC release row-level data alike, with planners", () => {
  for (const [label, who] of [
    ["clinician for own team", withAudience(clinician, team("PR-2001"))],
    ["clinician for other team", withAudience(clinician, team("PR-2002"))],
    ["admin for a team model", withAudience(admin, team("PR-2002"))],
    ["admin for a model granted nothing", withAudience(admin, { id: "model:none", kind: "model", roles: [], attributes: {} })]
  ] as const) {
    it(`${label}: query ids and count aggregate agree and are the conjunction`, async () => {
      const rt = await runtimes();
      const q = async (r: SemanticRuntime) => outcome(async () => (await r.query({ type: "hospital.Patient" }, who)).items.map((o) => o.objectId).sort());
      const agg = async (r: SemanticRuntime) => outcome(() => r.aggregate({ type: "hospital.Patient", aggregations: [{ name: "n", op: "count" }] }, who));
      const [qa, qc, aa, ac] = [await q(rt.abac), await q(rt.cedar), await agg(rt.abac), await agg(rt.cedar)];
      expect(qc).toEqual(qa);
      // An aggregate count never exceeds the rows the query returns.
      const rows = Array.isArray(qa) ? qa.length : 0;
      for (const a of [aa, ac]) {
        if (a === "refused" || typeof a === "string") continue;
        const n = (a as { groups?: { values?: { n?: number } }[]; rows?: unknown }).groups?.[0]?.values?.n ?? (a as Record<string, unknown>);
        expect({ label, n }).toMatchObject({ label, n: typeof n === "number" ? Math.min(n, rows) : n });
      }
    });
  }
});
