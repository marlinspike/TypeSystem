import type { TraitDefinition } from "../../model/trait.js";

/**
 * Deliberately property-only: the concrete "maintenance history" relationship
 * (e.g. Aircraft -> MaintenanceEvent) names a domain-specific target type, so
 * it belongs on the domain Type itself, not on this domain-neutral trait. See
 * docs/developer-guide/adding-a-domain.md for the reasoning.
 */
export const MaintainableTrait: TraitDefinition = {
  name: "Maintainable",
  description: "Adds maintenance status tracking fields shared by any maintainable asset.",
  schema: {
    type: "object",
    properties: {
      maintenanceStatus: { type: "string", enum: ["operational", "degraded", "down"] },
      lastMaintainedAt: { type: "string", format: "date-time" }
    }
  }
};
