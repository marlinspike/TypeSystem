import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

describe("Aircraft.needsAttention (cross-source computed property, ADR-0022)", () => {
  it("is false for a healthy aircraft with no maintenance history at all", async () => {
    const { runtime } = await buildAirforceTestbed();
    // AF86-0212 is "operational" and has zero seeded MaintenanceEvents.
    const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0212", demoIdentities.maintainer);
    expect(aircraft.values.needsAttention).toBe(false);
  });

  it("is true from the aircraft's OWN source alone (degraded maintenanceStatus) — the own-source short-circuit in computeNeedsAttention", async () => {
    const { runtime } = await buildAirforceTestbed();
    // AF86-0147 is seeded "degraded" — true without needing any maintenance
    // history to exist at all (unlike the foreign-source path below).
    const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(aircraft.values.needsAttention).toBe(true);
  });

  it("is true purely from a FOREIGN source (an open WorkOrder) even when the aircraft's own maintenanceStatus is healthy", async () => {
    const { runtime, inMemoryAdapter } = await buildAirforceTestbed();

    // Re-seed AF86-0147 as healthy, isolating the foreign-source path from the
    // own-source short-circuit exercised in the test above.
    inMemoryAdapter.seed("airforce.Aircraft", [
      {
        objectId: "AF86-0147",
        values: {
          id: "AF86-0147",
          tailNumber: "AF86-0147",
          model: "F-16C",
          maintenanceStatus: "operational",
          lastMaintainedAt: "2026-09-15T09:30:00.000Z"
        }
      }
    ]);

    const healthyBeforeWorkOrder = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(healthyBeforeWorkOrder.values.needsAttention).toBe(false);

    // A real action invocation, opening a real (default "open", i.e. not "closed") WorkOrder
    // against one of AF86-0147's seeded MaintenanceEvents (EVT-9001) — the foreign source.
    await runtime.invokeAction(
      "CreateMaintenanceWorkOrder",
      { maintenanceEventId: "EVT-9001", assignedTo: "SrA Chen" },
      demoIdentities.maintainer
    );

    const afterWorkOrder = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(afterWorkOrder.values.needsAttention).toBe(true);
  });
});
