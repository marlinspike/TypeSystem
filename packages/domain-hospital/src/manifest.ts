import type { DomainManifest } from "@typesys/core";
import { PatientType } from "./types/patient.js";
import { ProviderType } from "./types/provider.js";
import { AppointmentType } from "./types/appointment.js";
import { hospitalDataSources, hospitalMappings } from "./mappings/index.js";

/**
 * Everything the hospital domain contributes to the registry —
 * `docs/developer-guide/adding-a-domain.md`'s walkthrough, as real,
 * tested code rather than only documentation prose. Registering a
 * brand-new domain means authoring exactly this shape and calling
 * `registerDomain` — no changes to `packages/core`.
 */
export const hospitalManifest: DomainManifest = {
  domain: "hospital",
  // Patient extends core.Person, which coreManifest already registers;
  // Provider/Appointment don't extend anything, so order among the three
  // doesn't matter beyond coreManifest being registered first.
  types: [PatientType, ProviderType, AppointmentType],
  dataSources: hospitalDataSources,
  mappings: hospitalMappings
};
