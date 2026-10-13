import { buildPack } from "@typesys/packs";
import { airforceManifest } from "./manifest.js";

/**
 * The airforce domain as a pack (ADR-0059): what `airforceManifest`
 * registers, as data, requiring the core pack. Its code is
 * `airforceBindingRegistry`; its policy rules are `airforcePolicyRules`
 * (or the Cedar policies in `@typesys/policy-cedar`'s examples).
 */
export const airforcePack = buildPack({
  name: "airforce",
  version: "1.0.0",
  description: "Aircraft, components, maintenance events and work orders across an aircraft repository and a maintenance system, with readiness and attention computed from both, and Actions to open and progress work orders.",
  requires: { core: "^1.0.0" },
  manifests: [airforceManifest]
});
