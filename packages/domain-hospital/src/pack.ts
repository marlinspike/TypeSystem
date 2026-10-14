import { buildPack } from "@typesys/packs";
import { hospitalManifest } from "./manifest.js";

/** The hospital domain as a pack (ADR-0059), requiring the core pack. It names no code. */
export const hospitalPack = buildPack({
  name: "hospital",
  version: "1.0.0",
  description: "Patients, providers and appointments, with field-level protection of patient identifiers.",
  requires: { core: "^1.0.0" },
  manifests: [hospitalManifest]
});
