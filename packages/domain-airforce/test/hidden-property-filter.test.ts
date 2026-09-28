import { describe, it, expect } from "vitest";
import { AuthorizationError, type QueryFilter } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

// `Aircraft.maintenanceStatus` is maintainer-only (a property policy); viewers can read the Aircraft
// but see that field redacted. The top-level filter runs in the adapter against raw values, so
// without a check a viewer could filter on the hidden field and learn it from which rows come back.
const hiddenStatusFilters: [string, QueryFilter][] = [
  ["eq", { property: "maintenanceStatus", operator: "eq", value: "degraded" }],
  ["ne", { property: "maintenanceStatus", operator: "ne", value: "operational" }],
  [
    "nested in or",
    { or: [{ property: "tailNumber", operator: "eq", value: "NOPE" }, { property: "maintenanceStatus", operator: "eq", value: "degraded" }] }
  ]
];

describe("Filtering on a property the caller can't read", () => {
  it.each(hiddenStatusFilters)("rejects a viewer's filter on a redacted property (%s)", async (_label, filter) => {
    const { runtime } = await buildAirforceTestbed();
    await expect(runtime.query({ type: "airforce.Aircraft", filter }, demoIdentities.viewer)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("audits the rejected probe as a denial on that property", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    await expect(
      runtime.query({ type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "degraded" } }, demoIdentities.viewer)
    ).rejects.toBeInstanceOf(AuthorizationError);

    const { items } = await registry.listAuditEvents();
    const denial = items.find((e) => e.decision === "deny" && e.resource.propertyPath === "maintenanceStatus");
    expect(denial?.subjectId).toBe(demoIdentities.viewer.subjectId);
  });

  it("still lets a maintainer, who can read the property, filter on it", async () => {
    const { runtime } = await buildAirforceTestbed();
    const result = await runtime.query(
      { type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "degraded" } },
      demoIdentities.maintainer
    );
    expect(result.items.map((i) => i.objectId)).toEqual(["AF86-0147"]);
  });

  it("still lets a viewer filter on properties they can read", async () => {
    const { runtime } = await buildAirforceTestbed();
    const result = await runtime.query(
      { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" } },
      demoIdentities.viewer
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.values.maintenanceStatus).toBeUndefined(); // still redacted in the result
  });
});
