import type { DomainTypeEntry } from "../../registry/manifest.js";

export const EventType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Event/1.0.0",
    title: "Event",
    description: "Something that happened at a point in time, tracked by the enterprise (e.g. a maintenance event).",
    type: "object",
    properties: {
      id: { type: "string" },
      occurredAt: { type: "string", format: "date-time" },
      description: { type: "string" }
    },
    required: ["id", "occurredAt"]
  },
  options: { name: "core.Event", version: "1.0.0" }
};
