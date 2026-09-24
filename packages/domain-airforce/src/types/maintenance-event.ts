import type { DomainTypeEntry } from "@typesys/core";
import { MAINTENANCE_DATA_SOURCE_ID } from "./aircraft.js";

export const MaintenanceEventType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/MaintenanceEvent/1.0.0",
    title: "MaintenanceEvent",
    description: "A maintenance action performed or reported against an aircraft.",
    type: "object",
    properties: {
      aircraftId: { type: "string" },
      eventType: { type: "string" }
    },
    required: ["aircraftId", "eventType"],
    "x-relationships": {
      workOrder: {
        target: "airforce.WorkOrder",
        cardinality: "one-to-one",
        description: "The work order opened against this maintenance event, if any.",
        resolution: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID, operation: "byForeignKey:maintenanceEventId" }
      }
    },
    "x-actions": { actions: ["CreateMaintenanceWorkOrder"] },
    "x-policy": { objectPolicy: "airforce.read-aircraft" }
  },
  options: {
    name: "airforce.MaintenanceEvent",
    version: "1.0.0",
    extends: "core.Event"
  }
};
