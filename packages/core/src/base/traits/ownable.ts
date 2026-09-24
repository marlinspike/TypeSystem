import type { TraitDefinition } from "../../model/trait.js";

export const OwnableTrait: TraitDefinition = {
  name: "Ownable",
  description: "Adds an owning-party relationship to any ownable entity.",
  schema: { type: "object" },
  relationships: {
    owner: {
      target: "core.Party",
      cardinality: "one-to-one",
      description: "The party that owns or is responsible for this entity.",
      resolution: { dataSourceId: "unresolved", operation: "unresolved" }
    }
  }
};
