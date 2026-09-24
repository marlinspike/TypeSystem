import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SchemaValidationError } from "../src/registry/validation.js";
import { coreManifest } from "../src/base/manifest.js";
import { registerDomain } from "../src/registry/manifest.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

describe("Type registration and validation", () => {
  it("registers the core manifest's hand-authored types without throwing", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registerDomain(registry, coreManifest);

    const party = await registry.getType("core.Party");
    expect(party).toBeDefined();
    expect(party?.schema.$id).toBe("https://typesys.dev/types/core/Party/1.0.0");
  });

  it("rejects a schema that fails to compile under Ajv 2020-12", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const badSchema = {
      $id: "https://typesys.dev/types/test/Bad/1.0.0",
      title: "Bad",
      type: "object",
      properties: { a: { type: "not-a-real-type" } }
    } as unknown as SemanticTypeSchema;

    await expect(registry.registerType(badSchema, { name: "test.Bad", version: "1.0.0" })).rejects.toBeInstanceOf(
      SchemaValidationError
    );
  });

  it("tolerates the x-* vocabulary keywords under Ajv strict mode", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/WithXKeywords/1.0.0",
      title: "WithXKeywords",
      type: "object",
      properties: { name: { type: "string" } },
      "x-metadata": { owner: "test-team", tags: ["demo"] }
    };
    const def = await registry.registerType(schema, { name: "test.WithXKeywords", version: "1.0.0" });
    expect(def.schema["x-metadata"]).toEqual({ owner: "test-team", tags: ["demo"] });
  });
});
