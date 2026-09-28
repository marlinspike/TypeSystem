import type { DomainManifest } from "../registry/manifest.js";
import type { TraitDefinition } from "../model/trait.js";
import { PartyType } from "./types/party.js";
import { PersonType } from "./types/person.js";
import { OrganizationType } from "./types/organization.js";
import { LocationType } from "./types/location.js";
import { AssetType } from "./types/asset.js";
import { EventType } from "./types/event.js";
import { TrackableTrait } from "./traits/trackable.js";
import { MaintainableTrait } from "./traits/maintainable.js";
import { GeolocatableTrait } from "./traits/geolocatable.js";
import { OwnableTrait } from "./traits/ownable.js";

export { TrackableTrait, MaintainableTrait, GeolocatableTrait, OwnableTrait };

/**
 * Every core trait, keyed by name — the catalog declarative authoring
 * (`@typesys/cli`'s YAML loader) resolves a Type's `traits: [...]` name
 * list against. Domain packages with their own traits merge their own
 * catalog into this one; nothing here is hardcoded into the loader.
 */
export const coreTraits: Record<string, TraitDefinition> = {
  Trackable: TrackableTrait,
  Maintainable: MaintainableTrait,
  Geolocatable: GeolocatableTrait,
  Ownable: OwnableTrait
};

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
