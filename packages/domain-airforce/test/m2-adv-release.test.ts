import { describe, it, expect } from "vitest";
import { bindAudience, withAudience, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "../src/setup.js";

/** ADR-0067 adversarial: "every audit row of a bound identity carries details.audience". */
const { maintainer } = demoIdentities;
const { enclaveModel } = demoAudiences;

describe("m2-adv: audit of an audience-bound identity (ADR-0067)", () => {
  it("the invokeAction outcome row (auditRequired) of an identity bound to a model carries the audience", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    const agent = withAudience(maintainer, enclaveModel);
    await tb.runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" }, agent);
    const rows = (await tb.registry.listAuditEvents({ limit: 500 })).items.filter((e) => e.subjectId === maintainer.subjectId);
    const outcome = rows.filter((e) => e.operation === "invokeAction" && e.outcome === "success");
    expect(outcome).toHaveLength(1);
    expect(rows.filter((e) => e.details?.audience !== enclaveModel.id).map((e) => ({ operation: e.operation, action: e.action, outcome: e.outcome, details: e.details }))).toEqual([]);
  });

  it("held: a resolver (token claim) cannot widen the host's audience under the same id, nor bind a different one", async () => {
    const { enclaveModel: host } = demoAudiences;
    const forged: Identity = { ...maintainer, audience: { ...host, roles: ["maintainer"], clearance: "TOP_SECRET" } };
    const bound = await bindAudience(async () => forged, host)("t");
    expect(bound.audience).toEqual(host);
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    expect((await tb.runtime.getObject("airforce.Aircraft", "AF86-0147", bound)).values).not.toHaveProperty("deploymentLocation");
    await expect(bindAudience(async () => ({ ...maintainer, audience: { ...host, id: "model:other" } }), host)("t")).rejects.toThrow(/already bound/);
  });
});
