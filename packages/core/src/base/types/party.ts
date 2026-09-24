import type { DomainTypeEntry } from "../../registry/manifest.js";

export const PartyType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Party/1.0.0",
    title: "Party",
    description: "A person or organization capable of holding responsibility, ownership, or a role.",
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" }
    },
    required: ["id", "displayName"]
  },
  options: { name: "core.Party", version: "1.0.0" }
};
