import { buildPack } from "@typesys/packs";
import { coldChainManifest } from "./model.js";

/**
 * The cold chain's model as a pack (ADR-0059, ADR-0102): what
 * `coldChainManifest` registers, as data. It names no code at all, so a
 * deployment of it is entirely declared: these packs, the sources in
 * `coldChainDeployment`, and its policies.
 */
export const coldChainPack = buildPack({
  name: "coldchain",
  version: "1.0.0",
  description: "A pharmaceutical cold chain across a shipment tracker, a temperature sensor hub and a pharmacy inventory: shipments, sites, readings, excursions and lots, with Actions that quarantine, release and dispose of lots.",
  requires: { core: "^1.0.0" },
  manifests: [coldChainManifest]
});
