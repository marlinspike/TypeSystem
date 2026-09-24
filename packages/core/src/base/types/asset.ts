import type { DomainTypeEntry } from "../../registry/manifest.js";

export const AssetType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Asset/1.0.0",
    title: "Asset",
    description: "A physical or logical item of value an enterprise tracks, such as an aircraft, vehicle, or facility.",
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" }
    },
    required: ["id", "name"]
  },
  options: { name: "core.Asset", version: "1.0.0" }
};
