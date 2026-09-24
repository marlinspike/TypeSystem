import type { DomainTypeEntry } from "../../registry/manifest.js";

export const OrganizationType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/core/Organization/1.0.0",
    title: "Organization",
    description: "A group party such as a unit, company, or agency.",
    type: "object",
    properties: {
      orgType: { type: "string" }
    },
    "x-relationships": {
      members: {
        target: "core.Person",
        cardinality: "many-to-many",
        inverse: "affiliations",
        description: "People affiliated with this organization.",
        resolution: { dataSourceId: "unresolved", operation: "unresolved" }
      }
    }
  },
  options: { name: "core.Organization", version: "1.0.0", extends: "core.Party" }
};
