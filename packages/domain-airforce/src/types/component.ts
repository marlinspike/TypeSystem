import type { DomainTypeEntry } from "@typesys/core";

export const ComponentType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/airforce/Component/1.0.0",
    title: "Component",
    description: "An installable part or subsystem of an aircraft.",
    type: "object",
    properties: {
      aircraftId: { type: "string" },
      partNumber: { type: "string" },
      condition: { type: "string", enum: ["good", "fair", "poor"] }
    },
    required: ["aircraftId", "partNumber"],
    "x-policy": { objectPolicy: "airforce.read-aircraft" }
  },
  options: {
    name: "airforce.Component",
    version: "1.0.0",
    extends: "core.Asset"
  }
};
