import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

describe("Adapter substitution — same consumer-facing model, two adapter styles", () => {
  it("resolves a single query's object graph across the in-memory and mock-REST adapters with no adapter-specific branching", async () => {
    const { runtime } = await buildAirforceTestbed();

    const result = await runtime.query(
      {
        type: "airforce.Aircraft",
        filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" },
        include: [{ relationship: "components" }, { relationship: "maintenance" }]
      },
      demoIdentities.maintainer
    );

    expect(result.items).toHaveLength(1);
    const aircraft = result.items[0]!;
    expect(aircraft.values.tailNumber).toBe("AF86-0147");

    // Aircraft + components came from the in-memory repository adapter.
    const components = aircraft.values.components as { values: Record<string, unknown> }[];
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.values.partNumber).sort()).toEqual(["AVI-200", "ENG-100"]);

    // Maintenance events came from the mocked external REST adapter, translated into
    // the same canonical shape — the test asserts on values, never on which adapter produced them.
    const maintenance = aircraft.values.maintenance as { values: Record<string, unknown> }[];
    expect(maintenance).toHaveLength(2);
    expect(maintenance.map((m) => m.values.eventType).sort()).toEqual(["scheduled", "unscheduled"]);
  });

  it("navigates from a maintenance event to its work order across adapters via getRelationship", async () => {
    const { runtime } = await buildAirforceTestbed();

    await runtime.invokeAction(
      "CreateMaintenanceWorkOrder",
      { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" },
      demoIdentities.maintainer
    );

    const workOrders = await runtime.getRelationship(
      "airforce.MaintenanceEvent",
      "EVT-9001",
      "workOrder",
      demoIdentities.maintainer
    );
    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]?.values.assignedTo).toBe("SSgt Rivera");
    expect(workOrders[0]?.values.status).toBe("open");
  });

  it("getObject retrieves an Aircraft by its natural tail-number identifier", async () => {
    const { runtime } = await buildAirforceTestbed();
    const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities.maintainer);
    expect(aircraft.values.model).toBe("F-16C");
  });
});
