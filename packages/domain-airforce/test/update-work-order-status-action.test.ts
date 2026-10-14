import { describe, it, expect } from "vitest";
import { AuthorizationError, PreconditionFailedError } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/index.js";

/** The domain's instance-scoped Action (ADR-0053): decided on each WorkOrder's own assignee. */
describe("UpdateWorkOrderStatus (instance-scoped, ADR-0053)", () => {
  async function withWorkOrder(assignedTo: string) {
    const testbed = await buildAirforceTestbed();
    const created = (await testbed.runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo }, demoIdentities.maintainer)) as { id: string };
    return { ...testbed, id: created.id };
  }

  it("lets the assignee move their own work order, and reads its status back fresh", async () => {
    const { runtime, id } = await withWorkOrder("SSgt Rivera");
    await expect(runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: id, status: "in-progress" }, demoIdentities.maintainer)).resolves.toMatchObject({ status: "in-progress" });
    expect((await runtime.getObject("airforce.WorkOrder", id, demoIdentities.maintainer)).values.status).toBe("in-progress");
  });

  it("refuses a maintainer the work order isn't assigned to, and lets a lead", async () => {
    const { runtime, id } = await withWorkOrder("TSgt Okafor");
    await expect(runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: id, status: "closed" }, demoIdentities.maintainer)).rejects.toBeInstanceOf(AuthorizationError);
    const lead = { ...demoIdentities.maintainer, subjectId: "user-lead-1", roles: ["maintainer", "lead"], attributes: { displayName: "MSgt Chen" } };
    await expect(runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: id, status: "closed" }, lead)).resolves.toMatchObject({ status: "closed" });
  });

  it("keeps a closed work order closed, checked on the target's own status", async () => {
    const { runtime, id } = await withWorkOrder("SSgt Rivera");
    await runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: id, status: "closed" }, demoIdentities.maintainer);
    await expect(runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: id, status: "open" }, demoIdentities.maintainer)).rejects.toBeInstanceOf(PreconditionFailedError);
    const preview = await runtime.previewAction("UpdateWorkOrderStatus", { workOrderId: id, status: "open" }, demoIdentities.maintainer);
    expect(preview.blockers).toEqual([{ kind: "precondition", message: "Precondition failed: A closed work order cannot change status" }]);
  });

  it("says per work order who may act, without acting", async () => {
    const { runtime, id } = await withWorkOrder("SSgt Rivera");
    const listed = await runtime.listActions("airforce.WorkOrder", demoIdentities.maintainer, { objectId: id });
    expect(listed.map((a) => [a.action.name, a.authorized])).toEqual([["UpdateWorkOrderStatus", true]]);
    expect((await runtime.listActions("airforce.WorkOrder", demoIdentities.viewer, { objectId: id }))[0]!.authorized).toBe(false);
  });
});
