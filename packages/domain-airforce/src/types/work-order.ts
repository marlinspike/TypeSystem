import type { DomainTypeEntry } from "@typesys/core";

export const WorkOrderType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/WorkOrder/1.0.0",
    title: "WorkOrder",
    description: "A unit of maintenance work opened against a MaintenanceEvent.",
    type: "object",
    properties: {
      id: { type: "string" },
      maintenanceEventId: { type: "string" },
      status: { type: "string", enum: ["open", "in-progress", "closed"] },
      assignedTo: { type: "string" },
      createdAt: { type: "string", format: "date-time" }
    },
    required: ["id", "maintenanceEventId", "status"],
    "x-policy": { objectPolicy: "airforce.read-aircraft" }
  },
  options: {
    name: "airforce.WorkOrder",
    version: "1.0.0"
  }
};
