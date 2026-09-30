import {
  allOf,
  allowAllRule,
  anyOf,
  buildRuntime,
  coreManifest,
  requireAttributeMatch,
  requireRole,
  type Identity,
  type PolicyEngine,
  type PolicyRule,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { hospitalManifest } from "./manifest.js";
import { HOSPITAL_DATA_SOURCE_ID } from "./types/patient.js";
import { samplePatients } from "./sample-data/patients.js";
import { sampleProviders } from "./sample-data/providers.js";
import { sampleAppointments } from "./sample-data/appointments.js";

export interface HospitalTestbed {
  registry: SemanticRegistry;
  runtime: SemanticRuntime;
  policyEngine: PolicyEngine;
  adapter: InMemoryRepositoryAdapter;
}

/**
 * Builds a fully wired hospital testbed — the same `buildRuntime`
 * (`@typesys/core`) sequence `packages/domain-airforce/src/setup.ts`
 * uses, proving it's generic across two unrelated domains, not
 * accidentally airforce-specific. Reused by this package's own tests and
 * by anything (an MCP bootstrap, a demo) that wants a second, real,
 * running domain alongside airforce.
 */
/** This domain's named policy rules — exported so a runtime hosting several domains (the demo web app) can register them alongside others'. */
export const hospitalPolicyRules: Record<string, PolicyRule> = {
  // Provider directory is not sensitive — anyone can browse clinicians.
  "hospital.read-provider": allowAllRule,
  // Per-instance (ADR-0030), decided on each Patient's own attributes: a
  // clinician reads only the patients assigned to them, a patient only their
  // own record, an admin every record.
  "hospital.read-patient": anyOf(
    requireRole("admin"),
    allOf(requireRole("clinician"), requireAttributeMatch("assignedClinicianId", "providerId")),
    allOf(requireRole("patient"), requireAttributeMatch("id", "patientId"))
  ),
  // Still role-level: which clinicians may see an appointment is a domain
  // choice this demo doesn't make (see ADR-0030's review notes).
  "hospital.read-appointment": requireRole("clinician", "admin", "patient"),
  // Sensitive identifiers within an otherwise-readable Patient stay staff-only.
  "hospital.staff-only": requireRole("clinician", "admin")
};

export async function buildHospitalTestbed(): Promise<HospitalTestbed> {
  const adapter = new InMemoryRepositoryAdapter(HOSPITAL_DATA_SOURCE_ID, "hospital-repo");
  adapter.seed("hospital.Patient", samplePatients);
  adapter.seed("hospital.Provider", sampleProviders);
  adapter.seed("hospital.Appointment", sampleAppointments);

  const { registry, runtime, policyEngine } = await buildRuntime({
    manifests: [coreManifest, hospitalManifest],
    adapters: [adapter],
    policyRules: hospitalPolicyRules
  });

  return { registry, runtime, policyEngine, adapter };
}

/**
 * Canned demo identities for this domain (mirrors `demoIdentities` in
 * `@typesys/domain-airforce`). A clinician's `providerId` and a patient's
 * `patientId` are what `hospital.read-patient` matches against each
 * Patient's attributes (ADR-0030).
 */
export const hospitalDemoIdentities: Record<"clinician" | "otherClinician" | "patient" | "anonymous", Identity> = {
  clinician: { subjectId: "user-clinician-1", roles: ["clinician"], attributes: { providerId: "PR-2001" } },
  otherClinician: { subjectId: "user-clinician-2", roles: ["clinician"], attributes: { providerId: "PR-2002" } },
  patient: { subjectId: "user-patient-1", roles: ["patient"], attributes: { patientId: "PT-1001" } },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};
