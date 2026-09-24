import type { TraitDefinition } from "../../model/trait.js";

/**
 * Domain-neutral because its relationship target (core.Location) is itself
 * a core type — a trait may only reference relationship targets that are
 * core types or type parameters known ahead of time, never a domain type.
 */
export const GeolocatableTrait: TraitDefinition = {
  name: "Geolocatable",
  description: "Adds a current-location relationship to any locatable entity.",
  schema: { type: "object" },
  relationships: {
    location: {
      target: "core.Location",
      cardinality: "one-to-one",
      description: "The entity's current physical location.",
      resolution: { dataSourceId: "unresolved", operation: "unresolved" }
    }
  }
};
