import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { registerDomain } from "../src/registry/manifest.js";
import { coreManifest } from "../src/base/manifest.js";

describe("RelationshipDefinition — cardinalities", () => {
  it("supports many-to-many with a symmetric inverse (Person <-> Organization)", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const person = await registry.getType("core.Person");
    const org = await registry.getType("core.Organization");

    const affiliations = person?.relationships.find((r) => r.name === "affiliations");
    const members = org?.relationships.find((r) => r.name === "members");

    expect(affiliations?.cardinality).toBe("many-to-many");
    expect(affiliations?.targetType).toBe("core.Organization");
    expect(affiliations?.inverseName).toBe("members");

    expect(members?.cardinality).toBe("many-to-many");
    expect(members?.targetType).toBe("core.Person");
    expect(members?.inverseName).toBe("affiliations");
  });

  it("relationships are first-class registry records, independently listable by source type", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const rels = await registry.listRelationships("core.Person");
    expect(rels.map((r) => r.name)).toContain("affiliations");
    expect(rels[0]).toHaveProperty("id");
    expect(rels[0]).toHaveProperty("version");
  });
});
