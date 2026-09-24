import type { DomainManifest } from "../registry/manifest.js";
import { PartyType } from "./types/party.js";
import { PersonType } from "./types/person.js";
import { OrganizationType } from "./types/organization.js";
import { LocationType } from "./types/location.js";
import { AssetType } from "./types/asset.js";
import { EventType } from "./types/event.js";

export { TrackableTrait } from "./traits/trackable.js";
export { MaintainableTrait } from "./traits/maintainable.js";
export { GeolocatableTrait } from "./traits/geolocatable.js";
export { OwnableTrait } from "./traits/ownable.js";

/**
 * The core domain: base types every other domain package may extend or
 * reference, and nothing about aircraft, hospitals, or any other domain
 * concept (see ADR-0013).
 */
export const coreManifest: DomainManifest = {
  domain: "core",
  // Party must register before Person/Organization, which extend it.
  types: [PartyType, PersonType, OrganizationType, LocationType, AssetType, EventType]
};
