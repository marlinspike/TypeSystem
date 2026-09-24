import { describe, it, expect } from "vitest";
import { AuthorizationError } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

describe("Authorization boundaries", () => {
  it("denies object-level read entirely for an identity with no roles", async () => {
    const { runtime } = await buildAirforceTestbed();
    await expect(
      runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.anonymous)
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("retrieving an Aircraft does not imply every property is visible (property-level redaction)", async () => {
    const { runtime } = await buildAirforceTestbed();
    const asViewer = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.viewer);
    expect("model" in asViewer.values).toBe(true);
    expect("maintenanceStatus" in asViewer.values).toBe(false);
  });

  it("listActions reports an action as unauthorized for a role without invoke rights, without throwing", async () => {
    const { runtime } = await buildAirforceTestbed();
    const actions = await runtime.listActions("airforce.MaintenanceEvent", demoIdentities.viewer);
    const createWorkOrder = actions.find((a) => a.action.name === "CreateMaintenanceWorkOrder");
    expect(createWorkOrder?.authorized).toBe(false);

    const asMaintainer = await runtime.listActions("airforce.MaintenanceEvent", demoIdentities.maintainer);
    expect(asMaintainer.find((a) => a.action.name === "CreateMaintenanceWorkOrder")?.authorized).toBe(true);
  });
});
