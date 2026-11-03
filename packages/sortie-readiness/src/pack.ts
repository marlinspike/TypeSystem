import { buildPack } from "@typesys/packs";
import { opsManifest } from "./model.js";

/** The sortie-readiness model as a pack (ADR-0059, ADR-0102). It names no code, so its deployment is entirely declared. */
export const opsPack = buildPack({
  name: "ops",
  version: "1.0.0",
  description: "Sortie readiness across a fleet registry, a parts depot and a crew roster: aircraft, requisitions and crew members.",
  requires: { core: "^1.0.0" },
  manifests: [opsManifest]
});
