import type { ActionDefinition, PreconditionBinding } from "@typesys/core";
import { MAINTENANCE_DATA_SOURCE_ID } from "../types/aircraft.js";

/**
 * Named (not inline) specifically so it can be registered under the same
 * key — "maintenanceEventExists" — in `airforceBindingRegistry`
 * (`../bindings.js`) for Postgres rehydration (see ADR-0015).
 */
export const maintenanceEventExists: PreconditionBinding = async (ctx) => {
  const input = ctx.input as { maintenanceEventId: string };
  const adapter = ctx.getAdapter(MAINTENANCE_DATA_SOURCE_ID);
  const resolved = await adapter.resolveProperties("airforce.MaintenanceEvent", input.maintenanceEventId, []);
  return Object.keys(resolved.values).length > 0;
};

/**
 * The vertical slice's one required Action (see ADR-0005). Its
 * precondition demonstrates the runtime enforcing business rules before
 * dispatch, and its implementation binding shows an Action reaching the
 * same adapter that already serves MaintenanceEvent/WorkOrder properties.
 */
export const CreateMaintenanceWorkOrderAction: ActionDefinition = {
  id: "action-create-maintenance-work-order",
  name: "CreateMaintenanceWorkOrder",
  description: "Opens a new work order against an existing maintenance event.",
  applicableTypes: ["airforce.MaintenanceEvent"],
  inputSchema: {
    type: "object",
    properties: {
      maintenanceEventId: { type: "string" },
      assignedTo: { type: "string" }
    },
    required: ["maintenanceEventId", "assignedTo"]
  },
  outputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      maintenanceEventId: { type: "string" },
      status: { type: "string" }
    }
  },
  authorizationPolicy: "airforce.maintainer-only",
  preconditions: [
    {
      description: "The referenced maintenance event must exist",
      bindingId: "maintenanceEventExists",
      check: maintenanceEventExists
    }
  ],
  implementation: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID, operation: "createWorkOrder" },
  sideEffects: "creates",
  idempotency: "none",
  auditRequired: true,
  version: "1.0.0"
};
