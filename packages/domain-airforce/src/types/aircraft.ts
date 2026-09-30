import { TrackableTrait, MaintainableTrait, type DomainTypeEntry } from "@typesys/core";
import { computeReadinessStatus } from "../computed/readiness-status.js";
import { computeNeedsAttention } from "../computed/needs-attention.js";

export { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID } from "../data-source-ids.js";
import { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID } from "../data-source-ids.js";

export const AircraftType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/Aircraft/1.0.0",
    title: "Aircraft",
    description: "A fixed-wing or rotary aircraft tracked by the Air Force domain.",
    type: "object",
    properties: {
      tailNumber: { type: "string" },
      model: { type: "string" },
      deploymentLocation: { type: "string", description: "Where the aircraft is forward-deployed. Classified SECRET (ADR-0032)." }
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
      },
      needsAttention: {
        // Combines maintenanceStatus (this Aircraft's own source) with a live
        // lookup against the maintenance system (a different DataSource this
        // Aircraft has no direct Mapping to) — see ADR-0022.
        dependsOn: ["maintenanceStatus"],
        binding: "computeNeedsAttention",
        resolutionMode: "live"
      }
    },
    "x-policy": {
      objectPolicy: "airforce.read-aircraft",
      propertyPolicies: {
        maintenanceStatus: "airforce.maintainer-only"
      }
    },
    // Enforced beside the policy above, never through it: only a subject cleared SECRET reads this field (ADR-0032).
    "x-provenance": {
      properties: { deploymentLocation: { classification: "SECRET" } }
    }
  },
  options: {
    name: "airforce.Aircraft",
    version: "1.0.0",
    extends: "core.Asset",
    traits: [TrackableTrait, MaintainableTrait],
    computedImplementations: { computeReadinessStatus, computeNeedsAttention }
  }
};
