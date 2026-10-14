import type { ActionDefinition, PreconditionBinding } from "@typesys/core";
import { MAINTENANCE_DATA_SOURCE_ID } from "../data-source-ids.js";

/**
 * A closed work order stays closed. Reads the target's own stored `status`
 * through `ctx.getProperty`, which an instance-scoped Action gets for the
 * object the runtime already authorized (ADR-0053).
 */
export const workOrderNotClosed: PreconditionBinding = async (ctx) => (await ctx.getProperty("status")) !== "closed";

/**
 * The domain's instance-scoped Action (ADR-0053): it acts on one WorkOrder,
 * named by `workOrderId`, and its policy decides on that work order's own
 * attributes — a maintainer may update the work orders assigned to them, a
 * lead any work order. A caller who may not read the work order cannot act on it.
 */
export const UpdateWorkOrderStatusAction: ActionDefinition = {
  id: "action-update-work-order-status",
  name: "UpdateWorkOrderStatus",
  description: "Moves one work order to a new status. Allowed to its assignee, or to a lead.",
  applicableTypes: ["airforce.WorkOrder"],
  target: { idFrom: "workOrderId" },
  inputSchema: {
    type: "object",
    properties: {
      workOrderId: { type: "string" },
      status: { type: "string", enum: ["open", "in-progress", "closed"] }
    },
    required: ["workOrderId", "status"],
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      maintenanceEventId: { type: "string" },
      status: { type: "string" },
      assignedTo: { type: "string" }
    }
  },
  authorizationPolicy: "airforce.work-order-assignee",
  preconditions: [{ description: "A closed work order cannot change status", bindingId: "workOrderNotClosed", check: workOrderNotClosed }],
  implementation: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID, operation: "updateWorkOrderStatus" },
  sideEffects: "mutates",
  idempotency: "natural",
  auditRequired: true,
  version: "1.0.0"
};
