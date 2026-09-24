import { TrackableTrait, MaintainableTrait, type DomainTypeEntry } from "@typesys/core";
import { computeReadinessStatus } from "../computed/readiness-status.js";

export const AIRCRAFT_DATA_SOURCE_ID = "in-memory-airforce-repo";
export const MAINTENANCE_DATA_SOURCE_ID = "mock-remis-rest";

export const AircraftType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/Aircraft/1.0.0",
    title: "Aircraft",
    description: "A fixed-wing or rotary aircraft tracked by the Air Force domain.",
    type: "object",
    properties: {
      tailNumber: { type: "string" },
      model: { type: "string" }
    },
    required: ["tailNumber", "model"],
    "x-relationships": {
      components: {
        target: "airforce.Component",
        cardinality: "one-to-many",
        description: "Installed components on this aircraft.",
        resolution: { dataSourceId: AIRCRAFT_DATA_SOURCE_ID, operation: "byForeignKey:aircraftId" }
      },
      maintenance: {
        target: "airforce.MaintenanceEvent",
        cardinality: "one-to-many",
        description: "Maintenance history for this aircraft.",
        resolution: { dataSourceId: MAINTENANCE_DATA_SOURCE_ID, operation: "byForeignKey:aircraftId" }
      }
    },
    "x-computed": {
      readinessStatus: {
        dependsOn: ["maintenanceStatus"],
        binding: "computeReadinessStatus",
        resolutionMode: "live"
      }
    },
    "x-policy": {
      objectPolicy: "airforce.read-aircraft",
      propertyPolicies: {
        maintenanceStatus: "airforce.maintainer-only"
      }
    }
  },
  options: {
    name: "airforce.Aircraft",
    version: "1.0.0",
    extends: "core.Asset",
    traits: [TrackableTrait, MaintainableTrait],
    computedImplementations: { computeReadinessStatus }
  }
};
