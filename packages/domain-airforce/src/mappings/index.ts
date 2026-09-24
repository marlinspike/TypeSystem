import type { DataSource, Mapping } from "@typesys/core";
import { AIRCRAFT_DATA_SOURCE_ID, MAINTENANCE_DATA_SOURCE_ID } from "../types/aircraft.js";

export const airforceDataSources: DataSource[] = [
  { id: AIRCRAFT_DATA_SOURCE_ID, name: "In-Memory Airforce Repository", kind: "in-memory" },
  { id: MAINTENANCE_DATA_SOURCE_ID, name: "Mock REMIS (external REST)", kind: "mock-rest" }
];

/**
 * Wildcard ("*") property mappings: both adapter styles return a whole
 * object per lookup, mirroring how a real repository read or REST GET
 * behaves (see ADR-0006) — no per-field mapping granularity is needed for
 * this vertical slice, though the model supports it.
 */
export const airforceMappings: Mapping[] = [
  {
    id: "map-aircraft-properties",
    typeName: "airforce.Aircraft",
    target: "property",
    targetName: "*",
    dataSourceId: AIRCRAFT_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  },
  {
    id: "map-component-properties",
    typeName: "airforce.Component",
    target: "property",
    targetName: "*",
    dataSourceId: AIRCRAFT_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  },
  {
    id: "map-maintenance-event-properties",
    typeName: "airforce.MaintenanceEvent",
    target: "property",
    targetName: "*",
    dataSourceId: MAINTENANCE_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  },
  {
    id: "map-work-order-properties",
    typeName: "airforce.WorkOrder",
    target: "property",
    targetName: "*",
    dataSourceId: MAINTENANCE_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  }
];
