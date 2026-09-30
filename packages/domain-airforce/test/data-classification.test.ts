import { describe, it, expect } from "vitest";
import { AuthorizationError, type Identity } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

/**
 * The airforce demo of ADR-0032: `Aircraft.deploymentLocation` is marked
 * SECRET. The Maintainer (cleared SECRET) sees it; the Viewer (cleared CUI)
 * reads the Aircraft without it — and without `maintenanceStatus`, which a
 * policy hides instead. Two independent controls on one read.
 */
const { maintainer, viewer } = demoIdentities;
/** A maintainer by role with no clearance: the policy allows, the classification can't. */
const unclearedMaintainer: Identity = { subjectId: "user-maintainer-2", roles: ["maintainer"], attributes: {} };

describe("airforce domain: classified deploymentLocation (ADR-0032)", () => {
  it("a SECRET-cleared maintainer sees the field; a CUI-cleared viewer gets the Aircraft without it", async () => {
    const { runtime } = await buildAirforceTestbed();
    expect((await runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer)).values.deploymentLocation).toBe("FOB ALPHA (exercise designation)");

    const asViewer = await runtime.getObject("airforce.Aircraft", "AF86-0147", viewer);
    expect(asViewer.values.tailNumber).toBe("AF86-0147");
    expect(asViewer.values).not.toHaveProperty("deploymentLocation"); // classification
    expect(asViewer.values).not.toHaveProperty("maintenanceStatus"); // policy
  });

  it("a maintainer with no clearance fails closed: the policy allows, the classification doesn't", async () => {
    const { runtime } = await buildAirforceTestbed();
    const read = await runtime.getObject("airforce.Aircraft", "AF86-0147", unclearedMaintainer);
    expect(read.values.maintenanceStatus).toBe("degraded");
    expect(read.values).not.toHaveProperty("deploymentLocation");
  });

  it("attack: the viewer can't reach it by query, projection, filter, sort, search, provenance, or include", async () => {
    const { runtime } = await buildAirforceTestbed();
    const listed = await runtime.query({ type: "airforce.Aircraft", select: ["deploymentLocation", "tailNumber"], includeProvenance: true }, viewer);
    for (const item of listed.items) {
      expect(Object.keys(item.values)).toEqual(["tailNumber"]);
      expect((item.provenance ?? []).map((p) => p.propertyPath)).toEqual(["tailNumber"]);
    }
    await expect(runtime.query({ type: "airforce.Aircraft", filter: { property: "deploymentLocation", operator: "icontains", value: "FOB" } }, viewer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.query({ type: "airforce.Aircraft", sort: [{ property: "deploymentLocation", direction: "asc" }] }, viewer)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.getProvenance("airforce.Aircraft", "AF86-0147", "deploymentLocation", viewer)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await runtime.query({ type: "airforce.Aircraft", search: { text: "FOB" } }, viewer)).items).toEqual([]);
    expect((await runtime.query({ type: "airforce.Aircraft", search: { text: "FOB" } }, maintainer)).items.map((i) => i.objectId)).toEqual(["AF86-0147"]);

    const withIncludes = await runtime.query({ type: "airforce.Aircraft", include: [{ relationship: "components" }, { relationship: "maintenance" }] }, viewer);
    expect(withIncludes.items).toHaveLength(2);
    expect(JSON.stringify(withIncludes)).not.toMatch(/FOB ALPHA|Home station/);
  });
});
