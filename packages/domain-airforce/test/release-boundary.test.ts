import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { AuthorizationError, audienceIdentity, withAudience, type Audience, type Identity, type SemanticRuntime } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "../src/setup.js";
import { sampleAircraft } from "../src/sample-data/aircraft.js";

/**
 * The release boundary (ADR-0067): with an audience bound, the runtime
 * decides every value for the person *and* the model it goes to. Being
 * allowed to read data never by itself releases it.
 */
const { maintainer, viewer } = demoIdentities;
const { enclaveModel, commercialModel } = demoAudiences;
const AIRCRAFT = "AF86-0147";

async function values(runtime: SemanticRuntime, id: string, who: Identity): Promise<Record<string, unknown> | "refused"> {
  try {
    return (await runtime.getObject("airforce.Aircraft", id, who)).values;
  } catch (err) {
    if (err instanceof AuthorizationError) return "refused";
    throw err;
  }
}

describe("the release boundary on the read path (ADR-0067)", () => {
  it("a maintainer may read the aircraft; a commercial model may receive none of it, so a maintainer reading for it gets nothing", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    expect(await values(runtime, AIRCRAFT, maintainer)).toMatchObject({ tailNumber: AIRCRAFT, maintenanceStatus: "degraded" });
    const forCommercial = withAudience(maintainer, commercialModel);
    // The caller is told only that it was refused while reading for the model (the review's M8); the audit row says why.
    await expect(runtime.getObject("airforce.Aircraft", AIRCRAFT, forCommercial)).rejects.toMatchObject({ reason: "Refused while reading for model:commercial-api/general" });
    const { items } = await registry.listAuditEvents({ limit: 20 });
    expect(items.some((e) => e.decision === "deny" && /^Not releasable to model:commercial-api\/general/.test(e.reason ?? ""))).toBe(true);
    await expect(runtime.query({ type: "airforce.Aircraft" }, forCommercial)).rejects.toThrow(AuthorizationError);
    await expect(runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" }, forCommercial)).rejects.toThrow(AuthorizationError);
  });

  it("the enclave model receives what a maintainer reads below its own clearance: never the SECRET location the maintainer sees", async () => {
    const { runtime } = await buildAirforceTestbed();
    const both = await values(runtime, AIRCRAFT, withAudience(maintainer, enclaveModel));
    expect(both).toMatchObject({ tailNumber: AIRCRAFT, maintenanceStatus: "degraded" });
    expect(both).not.toHaveProperty("deploymentLocation");
    expect(await values(runtime, AIRCRAFT, maintainer)).toHaveProperty("deploymentLocation");
    await expect(runtime.getProvenance("airforce.Aircraft", AIRCRAFT, "deploymentLocation", withAudience(maintainer, enclaveModel))).rejects.toThrow(AuthorizationError);
    expect(await runtime.getProvenance("airforce.Aircraft", AIRCRAFT, "deploymentLocation", maintainer)).not.toHaveLength(0);
  });

  it("binding a model never widens what its person reads: a viewer reading for the enclave model still lacks maintenanceStatus", async () => {
    const { runtime } = await buildAirforceTestbed();
    const both = await values(runtime, AIRCRAFT, withAudience(viewer, enclaveModel));
    expect(both).toMatchObject({ tailNumber: AIRCRAFT });
    expect(both).not.toHaveProperty("maintenanceStatus");
  });

  it("every decision made for an audience is audited with it", async () => {
    const tb = await buildAirforceTestbed();
    await values(tb.runtime, AIRCRAFT, withAudience(maintainer, enclaveModel));
    const rows = (await tb.registry.listAuditEvents({ limit: 500 })).items.filter((e) => e.subjectId === maintainer.subjectId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.details?.audience === enclaveModel.id)).toBe(true);
    const location = rows.find((e) => e.resource.propertyPath === "deploymentLocation");
    expect(location).toMatchObject({ decision: "deny", details: { audience: enclaveModel.id, audienceClearance: "CUI" } });
  });

  it("an identity cannot be re-bound to a different audience", () => {
    expect(() => withAudience(withAudience(maintainer, enclaveModel), commercialModel)).toThrow(/already bound/);
    expect(withAudience(withAudience(maintainer, enclaveModel), enclaveModel).audience).toEqual(enclaveModel);
  });
});

/**
 * The invariant, over generated people and audiences: what a person reads
 * for an audience is exactly what both may read, never more. Refused when
 * either is refused; otherwise the values both would see, and only those.
 */
describe("release invariant, property-based (ADR-0067)", () => {
  const roles = fc.subarray(["maintainer", "viewer", "lead", "ai-enclave"]);
  const clearance = fc.option(fc.constantFrom("UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET", "BOGUS"), { nil: undefined });
  const person = fc.record({ roles, clearance }).map(({ roles, clearance }): Identity => ({ subjectId: "p", roles, attributes: { displayName: "SSgt Rivera" }, ...(clearance ? { clearance } : {}) }));
  const audience = fc.record({ roles, clearance }).map(({ roles, clearance }): Audience => ({ id: "model:generated", kind: "model", roles, attributes: {}, ...(clearance ? { clearance } : {}) }));
  const ids = sampleAircraft.map((a) => a.objectId);

  it("getObject for person+audience equals the intersection of each alone", async () => {
    const { runtime } = await buildAirforceTestbed();
    await fc.assert(
      fc.asyncProperty(person, audience, fc.constantFrom(...ids), async (p, a, id) => {
        const [alone, model, both] = await Promise.all([values(runtime, id, p), values(runtime, id, audienceIdentity(a)), values(runtime, id, withAudience(p, a))]);
        if (alone === "refused" || model === "refused") {
          expect(both).toBe("refused");
          return;
        }
        expect(both).not.toBe("refused");
        const expected = Object.fromEntries(Object.entries(alone).filter(([k, v]) => Object.hasOwn(model, k) && JSON.stringify(model[k]) === JSON.stringify(v)));
        expect(both).toEqual(expected);
      }),
      { numRuns: 120, seed: 20261014 }
    );
  });

  it("query for person+audience returns no object, and no value of one, that either alone could not read", async () => {
    const { runtime } = await buildAirforceTestbed();
    const page = async (who: Identity) => runtime.query({ type: "airforce.Aircraft", limit: 50 }, who).then((r) => r.items, (err: unknown) => (err instanceof AuthorizationError ? [] : Promise.reject(err as Error)));
    await fc.assert(
      fc.asyncProperty(person, audience, async (p, a) => {
        const [alone, model, both] = await Promise.all([page(p), page(audienceIdentity(a)), page(withAudience(p, a))]);
        const byId = (items: typeof alone) => new Map(items.map((o) => [o.objectId, o.values]));
        const [pa, ma] = [byId(alone), byId(model)];
        for (const o of both) {
          expect(pa.has(o.objectId) && ma.has(o.objectId)).toBe(true);
          for (const k of Object.keys(o.values)) {
            expect(Object.hasOwn(pa.get(o.objectId)!, k) && Object.hasOwn(ma.get(o.objectId)!, k)).toBe(true);
          }
        }
        // And nothing both may read is lost: an object both read in full comes back.
        for (const [id, values] of pa) if (ma.has(id)) expect(both.some((o) => o.objectId === id) || Object.keys(values).length === 0).toBe(true);
      }),
      { numRuns: 60, seed: 20261014 }
    );
  });
});
