import { requireRole, allowAllRule, buildRuntime, coreManifest, type SemanticRegistry, type SemanticRuntime, type Identity, type PolicyEngine } from "@typesys/core";
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
export async function buildHospitalTestbed(): Promise<HospitalTestbed> {
  const adapter = new InMemoryRepositoryAdapter(HOSPITAL_DATA_SOURCE_ID, "hospital-repo");
  adapter.seed("hospital.Patient", samplePatients);
  adapter.seed("hospital.Provider", sampleProviders);
  adapter.seed("hospital.Appointment", sampleAppointments);

  const { registry, runtime, policyEngine } = await buildRuntime({
    manifests: [coreManifest, hospitalManifest],
    adapters: [adapter],
    policyRules: {
      // Provider directory is not sensitive — anyone can browse clinicians.
      "hospital.read-provider": allowAllRule,
      // A patient can see their own record/appointments (simplified here to "any
      // patient-role identity", the same object-vs-property split ADR-0009's ABAC
      // engine already demonstrates for airforce — per-instance ownership scoping
      // is a documented, not-built extension point, not something this domain adds).
      "hospital.read-patient": requireRole("clinician", "admin", "patient"),
      "hospital.read-appointment": requireRole("clinician", "admin", "patient"),
      // Sensitive identifiers within an otherwise-readable Patient stay staff-only.
      "hospital.staff-only": requireRole("clinician", "admin")
    }
  });

  return { registry, runtime, policyEngine, adapter };
}

/** Canned demo identities for this domain (mirrors `demoIdentities` in `@typesys/domain-airforce`). */
export const hospitalDemoIdentities: Record<"clinician" | "patient" | "anonymous", Identity> = {
  clinician: { subjectId: "user-clinician-1", roles: ["clinician"], attributes: {} },
  patient: { subjectId: "user-patient-1", roles: ["patient"], attributes: {} },
  anonymous: { subjectId: "anonymous", roles: [], attributes: {} }
};
