import { coreManifest } from "@typesys/core";
import { buildPack } from "./archive.js";

/** The core base Types (`core.Party`, `core.Asset`, ...) as a pack, which domain packs require (ADR-0013). */
export const corePack = buildPack({
  name: "core",
  version: "1.0.0",
  description: "Base Types every domain may extend or reference: Party, Person, Organization, Location, Asset and Event, with the Trackable, Maintainable, Geolocatable and Ownable traits.",
  manifests: [coreManifest]
});
