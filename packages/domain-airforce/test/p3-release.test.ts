import { describe, it, expect } from "vitest";
import { withAudience } from "@typesys/core";
import { buildAirforceTestbed, demoAudiences, demoIdentities } from "../src/setup.js";

/**
 * Pressure test 3, ADR-0067 (amended after review M8): "A caller reading for
 * an audience is told only `Refused while reading for <audience>`, whatever
 * was refused and why." `invokeAction` holds this; `previewAction` returns
 * the policy decision's reason in its authorization blocker unmasked.
 */
const { maintainer } = demoIdentities;
const { enclaveModel } = demoAudiences;

async function workOrderPreview(assignedTo: string) {
  const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const created = (await tb.runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo }, maintainer)) as { id: string };
  const agent = withAudience(maintainer, enclaveModel);
  const preview = await tb.runtime.previewAction("UpdateWorkOrderStatus", { workOrderId: created.id, status: "closed" }, agent);
  let invoked: string | undefined;
  try {
    await tb.runtime.invokeAction("UpdateWorkOrderStatus", { workOrderId: created.id, status: "closed" }, agent);
  } catch (err) {
    invoked = (err as { reason?: string }).reason;
  }
  return { preview, invoked };
}

describe("p3: previews for an audience-bound caller (ADR-0067 M8)", () => {
  it("held: invokeAction tells the model the same thing for its user's work order and another's", async () => {
    const own = await workOrderPreview("SSgt Rivera");
    const other = await workOrderPreview("TSgt Okafor");
    expect(own.invoked).toBe(other.invoked);
    expect(own.invoked).toBe(`Refused while reading for ${enclaveModel.id}`);
  });

  it("P3-RL1: previewAction's authorization blocker does not tell the model whether a work order is assigned to its user", async () => {
    const own = await workOrderPreview("SSgt Rivera");
    const other = await workOrderPreview("TSgt Okafor");
    // Both refused...
    expect(own.preview.wouldExecute).toBe(false);
    expect(other.preview.wouldExecute).toBe(false);
    // ...and refused alike, with the one reason an audience caller is told.
    expect(own.preview.blockers).toEqual(other.preview.blockers);
    expect(own.preview.blockers).toEqual([{ kind: "authorization", message: `Refused while reading for ${enclaveModel.id}` }]);
  });
});
