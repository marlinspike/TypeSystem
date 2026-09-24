import type { DomainTypeEntry } from "../../registry/manifest.js";

export const PersonType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Person/1.0.0",
    title: "Person",
    description: "An individual human party.",
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      roleTitle: { type: "string" }
    },
    "x-relationships": {
      affiliations: {
        target: "core.Organization",
        cardinality: "many-to-many",
        inverse: "members",
        description: "Organizations this person is affiliated with.",
        resolution: { dataSourceId: "unresolved", operation: "unresolved" }
      }
    }
  },
  options: { name: "core.Person", version: "1.0.0", extends: "core.Party" }
};
