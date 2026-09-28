import type { DataSource, Mapping } from "@typesys/core";
import { HOSPITAL_DATA_SOURCE_ID } from "../types/patient.js";

export const hospitalDataSources: DataSource[] = [
  { id: HOSPITAL_DATA_SOURCE_ID, name: "In-Memory Hospital Repository", kind: "in-memory" }
];

/**
 * Wildcard ("*") property mappings — one adapter, one data source, all
 * three Types, mirroring `packages/domain-airforce/src/mappings/index.ts`.
 */
export const hospitalMappings: Mapping[] = [
  {
    id: "map-patient-properties",
    typeName: "hospital.Patient",
    target: "property",
    targetName: "*",
    dataSourceId: HOSPITAL_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  },
  {
    id: "map-provider-properties",
    typeName: "hospital.Provider",
    target: "property",
    targetName: "*",
    dataSourceId: HOSPITAL_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  },
  {
    id: "map-appointment-properties",
    typeName: "hospital.Appointment",
    target: "property",
    targetName: "*",
    dataSourceId: HOSPITAL_DATA_SOURCE_ID,
    operation: "get",
    resolutionMode: "live"
  }
];
