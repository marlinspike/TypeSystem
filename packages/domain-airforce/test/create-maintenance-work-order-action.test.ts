import { describe, it, expect } from "vitest";
import { AuthorizationError, InvalidInputError, PreconditionFailedError } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

describe("CreateMaintenanceWorkOrder action", () => {
  it("an authorized maintainer can invoke the action, and the invocation is audited", async () => {
    const { runtime, registry } = await buildAirforceTestbed();

    const result = (await runtime.invokeAction(
      "CreateMaintenanceWorkOrder",
      { maintenanceEventId: "EVT-9002", assignedTo: "SrA Chen" },
      demoIdentities.maintainer
    )) as { status: string; assignedTo: string };

    expect(result.status).toBe("open");
    expect(result.assignedTo).toBe("SrA Chen");

    const { items: auditEvents } = await registry.listAuditEvents();
    const actionAudit = auditEvents.find((e) => e.action === "CreateMaintenanceWorkOrder" && e.outcome === "success");
    expect(actionAudit).toBeDefined();
    expect(actionAudit?.subjectId).toBe(demoIdentities.maintainer.subjectId);
  });

  it("denies a read-only viewer identity from invoking the action, and audits the denial", async () => {
    const { runtime, registry } = await buildAirforceTestbed();

    await expect(
      runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9002", assignedTo: "x" }, demoIdentities.viewer)
    ).rejects.toBeInstanceOf(AuthorizationError);

    const { items: auditEvents } = await registry.listAuditEvents();
    const denial = auditEvents.find((e) => e.action === "CreateMaintenanceWorkOrder" && e.decision === "deny");
    expect(denial).toBeDefined();
    expect(denial?.subjectId).toBe(demoIdentities.viewer.subjectId);
  });

  it("fails the precondition when the referenced maintenance event does not exist", async () => {
    const { runtime } = await buildAirforceTestbed();

    await expect(
      runtime.invokeAction(
        "CreateMaintenanceWorkOrder",
        { maintenanceEventId: "EVT-DOES-NOT-EXIST", assignedTo: "SrA Chen" },
        demoIdentities.maintainer
      )
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it("rejects input that doesn't match the action's inputSchema, before the precondition or adapter runs", async () => {
    const { runtime } = await buildAirforceTestbed();

    await expect(
      runtime.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: 9002 }, demoIdentities.maintainer)
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("checks authorization before input shape, so an unauthorized caller's malformed call is still audited as a denial", async () => {
    const { runtime, registry } = await buildAirforceTestbed();

    await expect(runtime.invokeAction("CreateMaintenanceWorkOrder", { bogus: true }, demoIdentities.viewer)).rejects.toBeInstanceOf(
      AuthorizationError
    );

    const { items: auditEvents } = await registry.listAuditEvents();
    expect(auditEvents.some((e) => e.action === "CreateMaintenanceWorkOrder" && e.decision === "deny")).toBe(true);
  });
});
