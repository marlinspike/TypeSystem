import type { DomainTypeEntry } from "@typesys/core";
import { HOSPITAL_DATA_SOURCE_ID } from "./patient.js";

/**
 * A standalone Type — a clinician, not a subtype of any core Type in
 * this domain, unlike `Patient` (which extends `core.Person`). Proves
 * a domain doesn't have to extend a core base Type to be valid.
 */
export const ProviderType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Provider/1.0.0",
    title: "Provider",
    description: "A clinician who can be scheduled against an Appointment.",
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      specialty: { type: "string" }
    },
    required: ["id", "displayName"],
    "x-relationships": {
      appointments: {
        target: "hospital.Appointment",
        cardinality: "one-to-many",
        description: "Appointments this provider is scheduled for.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byForeignKey:providerId" }
      }
    },
    "x-policy": { objectPolicy: "hospital.read-provider" }
  },
  options: { name: "hospital.Provider", version: "1.0.0" }
};
