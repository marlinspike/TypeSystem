import type { DomainTypeEntry } from "@typesys/core";
import { HOSPITAL_DATA_SOURCE_ID } from "./patient.js";

/**
 * Carries the two relationships this domain uses to prove the
 * `byOwnField:<field>` convention (a one-to-one lookup by the source
 * record's own field value, added to `@typesys/adapter-in-memory`
 * specifically for this domain — see its test suite and
 * docs/developer-guide/adding-a-domain.md, which originally documented
 * this exact gap) alongside the `byForeignKey:<field>` convention
 * `Patient.appointments`/`Provider.appointments` already use.
 */
export const AppointmentType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Appointment/1.0.0",
    title: "Appointment",
    description: "A scheduled encounter between a Patient and a Provider.",
    type: "object",
    properties: {
      id: { type: "string" },
      patientId: { type: "string" },
      providerId: { type: "string" },
      scheduledAt: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["scheduled", "completed", "cancelled"] }
    },
    required: ["id", "patientId", "providerId", "scheduledAt", "status"],
    "x-relationships": {
      patient: {
        target: "hospital.Patient",
        cardinality: "one-to-one",
        description: "The patient this appointment is for.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byOwnField:patientId" }
      },
      provider: {
        target: "hospital.Provider",
        cardinality: "one-to-one",
        description: "The clinician this appointment is with.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byOwnField:providerId" }
      }
    },
    "x-policy": { objectPolicy: "hospital.read-appointment" }
  },
  options: { name: "hospital.Appointment", version: "1.0.0" }
};
