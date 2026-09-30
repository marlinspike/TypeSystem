import type { DomainTypeEntry } from "@typesys/core";

export const HOSPITAL_DATA_SOURCE_ID = "in-memory-hospital-repo";

/**
 * Extends `core.Person` rather than redefining name/contact fields from
 * scratch — `core.Person` already contributes `email`, `roleTitle`, and
 * an `affiliations` relationship to `core.Organization` (via `core.Party`).
 * See docs/developer-guide/adding-a-domain.md.
 */
export const PatientType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Patient/1.0.0",
    title: "Patient",
    description: "A person receiving care at this hospital.",
    type: "object",
    properties: {
      medicalRecordNumber: { type: "string" },
      dateOfBirth: { type: "string", format: "date" },
      assignedClinicianId: {
        type: "string",
        description: "The Provider responsible for this patient — what the per-instance read rule decides on (ADR-0030)."
      }
    },
    required: ["medicalRecordNumber"],
    "x-relationships": {
      appointments: {
        target: "hospital.Appointment",
        cardinality: "one-to-many",
        description: "Appointments scheduled for this patient.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byForeignKey:patientId" }
      },
      providers: {
        target: "hospital.Provider",
        cardinality: "many-to-many",
        description: "Providers this patient has appointments with, resolved many-to-many through the Appointment join collection (ADR-0028).",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byJoinTable:hospital.Appointment/patientId/providerId" }
      }
    },
    "x-policy": {
      objectPolicy: "hospital.read-patient",
      propertyPolicies: {
        medicalRecordNumber: "hospital.staff-only"
      }
    }
  },
  options: {
    name: "hospital.Patient",
    version: "1.0.0",
    extends: "core.Person"
  }
};
