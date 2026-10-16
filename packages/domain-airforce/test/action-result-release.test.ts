import { describe, it, expect } from "vitest";
import { withAudience } from "@typesys/core";
import { CreateMaintenanceWorkOrderAction } from "../src/actions/create-maintenance-work-order.js";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "../src/setup.js";

/**
 * An Action's result goes back to a caller reading for a model only as that
 * model may read it (ADR-0075): the effect has happened, and what is
 * returned is decided like a read of the object the result is.
 */
const { maintainer } = demoIdentities;
const { enclaveModel } = demoAudiences;
const INPUT = { maintenanceEventId: "EVT-9002", assignedTo: "SSgt Rivera" };

describe("an Action's result is released like a read (ADR-0075)", () => {
  it("the enclave model receives the new work order, as it may read work orders; the audit row records nothing withheld", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    const result = (await runtime.invokeAction("CreateMaintenanceWorkOrder", INPUT, withAudience(maintainer, enclaveModel))) as Record<string, unknown>;
    expect(result).toMatchObject({ id: expect.any(String) as unknown, maintenanceEventId: "EVT-9002" });
    const row = (await registry.listAuditEvents({ limit: 50 })).items.find((e) => e.action === "CreateMaintenanceWorkOrder" && e.decision === "allow");
    expect(row?.details).toEqual({ audience: enclaveModel.id, withheld: [] });
  });

  it("a result describing no object the runtime can decide is withheld from the model, and still returned to the person alone", async () => {
    const { runtime, registry } = await buildAirforceTestbed();
    const { outputType: _, ...untyped } = CreateMaintenanceWorkOrderAction;
    await registry.registerAction({ ...untyped, id: "action-untyped-work-order", name: "OpenUntypedWorkOrder" });
    expect(await runtime.invokeAction("OpenUntypedWorkOrder", INPUT, withAudience(maintainer, enclaveModel))).toEqual({});
    const row = (await registry.listAuditEvents({ limit: 50 })).items.find((e) => e.action === "OpenUntypedWorkOrder" && e.decision === "allow");
    expect(row?.details?.withheld).toEqual(expect.arrayContaining(["id", "maintenanceEventId"]) as unknown);
    expect(await runtime.invokeAction("OpenUntypedWorkOrder", INPUT, maintainer)).toMatchObject({ maintenanceEventId: "EVT-9002" });
  });
});
