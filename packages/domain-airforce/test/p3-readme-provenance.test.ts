import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";
import { MAINTENANCE_DATA_SOURCE_ID } from "../src/types/aircraft.js";

/**
 * 3.0 pressure test. The README says of `needsAttention`: "Its code reads `maintenanceStatus` and, if that alone
 * doesn't decide it, asks the maintenance system for open work orders against this aircraft. `getProvenance`
 * traces it back to the values it was derived from." When the work orders decide the value, the trace names
 * only `maintenanceStatus` (the declared `dependsOn`), which on its own says the flag should be false.
 */
describe("P3-R1: needsAttention provenance when the maintenance system decides it", () => {
  it("P3-R1: getProvenance names the maintenance system whose work order made needsAttention true", async () => {
    const { runtime, inMemoryAdapter } = await buildAirforceTestbed();
    inMemoryAdapter.seed("airforce.Aircraft", [
      {
        objectId: "AF86-0147",
        values: { id: "AF86-0147", tailNumber: "AF86-0147", model: "F-16C", maintenanceStatus: "operational" }
      }
    ]);
    await runtime.invokeAction(
      "CreateMaintenanceWorkOrder",
      { maintenanceEventId: "EVT-9001", assignedTo: "SrA Chen" },
      demoIdentities.maintainer
    );
    const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(aircraft.values.needsAttention).toBe(true);

    const trace = await runtime.getProvenance("airforce.Aircraft", "AF86-0147", "needsAttention", demoIdentities.maintainer);
    // Today the trace is exactly [maintenanceStatus = "operational" from airforce-repo]: a value that, by the
    // computation's own rule, cannot have produced `true`.
    expect(trace.map((p) => p.source.dataSourceId)).toContain(MAINTENANCE_DATA_SOURCE_ID);
  });
});
