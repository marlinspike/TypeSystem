import type { DomainTypeEntry } from "../../registry/manifest.js";

export const LocationType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Location/1.0.0",
    title: "Location",
    description: "A physical place, such as a base, facility, or site.",
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 }
    },
    required: ["id", "name"]
  },
  options: { name: "core.Location", version: "1.0.0" }
};
