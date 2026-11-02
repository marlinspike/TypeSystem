import type { Identity } from "@typesys/core";
import { DEPLOYMENT_FORMAT, type Deployment, type HostExtension } from "@typesys/host";
import { corePack } from "@typesys/packs";
import { AIRCRAFT_DATA_SOURCE_ID, airforcePack, MAINTENANCE_DATA_SOURCE_ID, airforceBindingRegistry, airforcePolicyDocument, airforceSampleAdapters, demoIdentities } from "@typesys/domain-airforce";
import { HOSPITAL_DATA_SOURCE_ID, hospitalPack, hospitalDemoIdentities, hospitalPolicyDocument, hospitalSampleAdapter } from "@typesys/domain-hospital";

/**
 * The two demonstration domains as deployments the generic host serves
 * (ADR-0102). Their systems are in memory and seeded with sample data, so
 * each needs one extension: the code that builds those seeded adapters,
 * and, for the airforce domain, the computed values and preconditions its
 * pack names. Everything else (packs, rules, classification, personas,
 * tokens) is data. `deployments/airforce.deployment.json` and
 * `deployments/hospital.deployment.json` are these, written out by
 * `npm run deployments`; the Docker image serves the airforce one.
 */

export const AIRFORCE_EXTENSION = "@typesys/demo-web/airforce-extension";
export const HOSPITAL_EXTENSION = "@typesys/demo-web/hospital-extension";

/**
 * The airforce systems, seeded, and the domain's bindings.
 * `TYPESYS_AIRFORCE_LATENCY_MS` sets the simulated maintenance system's
 * latency per call (default 1), as `buildAirforceTestbed`'s `mockRestLatencyMs` does.
 */
export const airforceExtension: HostExtension = {
  name: AIRFORCE_EXTENSION,
  bindings: airforceBindingRegistry,
  adapters: ({ env }) => {
    const raw = env.env("TYPESYS_AIRFORCE_LATENCY_MS");
    const latency = raw === undefined ? 1 : Number(raw);
    if (!Number.isFinite(latency) || latency < 0) throw new Error(`TYPESYS_AIRFORCE_LATENCY_MS must be a non-negative number of milliseconds, not "${raw}"`);
    const { inMemoryAdapter, mockRestAdapter } = airforceSampleAdapters(latency);
    return [inMemoryAdapter, mockRestAdapter];
  }
};

export const hospitalExtension: HostExtension = {
  name: HOSPITAL_EXTENSION,
  adapters: () => [hospitalSampleAdapter()]
};

const personas = (identities: Readonly<Record<string, Identity>>): Record<string, Identity> => ({ ...identities });

/** The airforce slice: Aircraft AF86-0147 and the rest, read as maintainer, lead, viewer or anonymous, with the SECRET field withheld from the viewer. */
export const airforceDeployment: Deployment = {
  format: DEPLOYMENT_FORMAT,
  name: "airforce",
  description: "Aircraft, components, maintenance events and work orders across an aircraft repository and a maintenance system. A demonstration: in-memory systems, fixed tokens.",
  demo: true,
  packs: [
    { name: "core", version: "1.0.0", digest: corePack.digest },
    { name: "airforce", version: "1.0.0", digest: airforcePack.digest }
  ],
  extensions: [AIRFORCE_EXTENSION],
  sources: {
    [AIRCRAFT_DATA_SOURCE_ID]: { kind: "extension", extension: AIRFORCE_EXTENSION, system: "airforce-repo" },
    [MAINTENANCE_DATA_SOURCE_ID]: { kind: "extension", extension: AIRFORCE_EXTENSION, system: "maintenance (simulated REST)" }
  },
  policies: airforcePolicyDocument,
  classification: { kind: "demo-linear" },
  identity: { kind: "tokens", tokens: { "demo-maintainer-token": "maintainer", "demo-viewer-token": "viewer", "demo-lead-token": "lead" } },
  personas: personas(demoIdentities)
};

/** The hospital slice: patients read per instance (a clinician their own patients, a patient their own record). */
export const hospitalDeployment: Deployment = {
  format: DEPLOYMENT_FORMAT,
  name: "hospital",
  description: "Patients, providers and appointments in one hospital repository, read per instance. A demonstration: an in-memory system, fixed tokens.",
  demo: true,
  packs: [
    { name: "core", version: "1.0.0", digest: corePack.digest },
    { name: "hospital", version: "1.0.0", digest: hospitalPack.digest }
  ],
  extensions: [HOSPITAL_EXTENSION],
  sources: { [HOSPITAL_DATA_SOURCE_ID]: { kind: "extension", extension: HOSPITAL_EXTENSION, system: "hospital-repo" } },
  policies: hospitalPolicyDocument,
  identity: { kind: "tokens", tokens: { "demo-clinician-token": "clinician", "demo-clinician-b-token": "otherClinician", "demo-patient-token": "patient", "demo-admin-token": "admin" } },
  // The admin reads every patient record, as the web demo's admin does.
  personas: { ...personas(hospitalDemoIdentities), admin: { subjectId: "user-admin-1", roles: ["admin"], attributes: {} } }
};
