import type { TraitDefinition } from "../../model/trait.js";

export const TrackableTrait: TraitDefinition = {
  name: "Trackable",
  description: "Adds identity-tracking fields for physical or logical tracking.",
  schema: {
    type: "object",
    properties: {
      trackingId: { type: "string" },
      lastTrackedAt: { type: "string", format: "date-time" }
    }
  }
};
