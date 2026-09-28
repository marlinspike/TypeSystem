import { describe, it, expect } from "vitest";
import type { RelationshipDefinition } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "../src/in-memory-repository-adapter.js";

function relationship(overrides: Partial<RelationshipDefinition>): RelationshipDefinition {
  return {
    id: "rel-test",
    name: "rel",
    sourceType: "test.Source",
    targetType: "test.Target",
    cardinality: "one-to-many",
    resolution: { dataSourceId: "mem", operation: "byForeignKey:sourceId" },
    version: "1.0.0",
    ...overrides
  };
}

describe("InMemoryRepositoryAdapter", () => {
  it("resolveProperties returns {} for an unseeded object, not an error", async () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    const { values, provenance } = await adapter.resolveProperties("test.Widget", "missing", []);
    expect(values).toEqual({});
    expect(provenance).toEqual([]);
  });

  it("byForeignKey: finds every target record whose field equals the source's id", async () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    adapter.seed("test.Target", [
      { objectId: "t1", values: { id: "t1", sourceId: "s1" } },
      { objectId: "t2", values: { id: "t2", sourceId: "s1" } },
      { objectId: "t3", values: { id: "t3", sourceId: "s2" } }
    ]);

    const related = await adapter.resolveRelationship(
      relationship({ resolution: { dataSourceId: "mem", operation: "byForeignKey:sourceId" } }),
      "s1"
    );
    expect(related.map((r) => r.objectId).sort()).toEqual(["t1", "t2"]);
  });

  it("byOwnField: looks up a single target by the source record's own field value", async () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    adapter.seed("test.Source", [{ objectId: "s1", values: { id: "s1", targetId: "t1" } }]);
    adapter.seed("test.Target", [{ objectId: "t1", values: { id: "t1", name: "Target One" } }]);

    const related = await adapter.resolveRelationship(
      relationship({
        cardinality: "one-to-one",
        resolution: { dataSourceId: "mem", operation: "byOwnField:targetId" }
      }),
      "s1"
    );
    expect(related).toEqual([{ objectId: "t1" }]);
  });

  it("byOwnField: returns [] when the source record has no such field (or doesn't exist)", async () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    adapter.seed("test.Source", [{ objectId: "s1", values: { id: "s1" } }]);

    const related = await adapter.resolveRelationship(
      relationship({ resolution: { dataSourceId: "mem", operation: "byOwnField:targetId" } }),
      "s1"
    );
    expect(related).toEqual([]);

    const relatedForMissingSource = await adapter.resolveRelationship(
      relationship({ resolution: { dataSourceId: "mem", operation: "byOwnField:targetId" } }),
      "does-not-exist"
    );
    expect(relatedForMissingSource).toEqual([]);
  });

  it("rejects an unrecognized relationship operation", async () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    await expect(
      adapter.resolveRelationship(relationship({ resolution: { dataSourceId: "mem", operation: "byWhatever:x" } }), "s1")
    ).rejects.toThrow(/only supports/);
  });

  it("put via seed() overwrites — seeding the same objectId twice keeps the latest", () => {
    const adapter = new InMemoryRepositoryAdapter("mem");
    adapter.seed("test.Widget", [{ objectId: "w1", values: { status: "draft" } }]);
    adapter.seed("test.Widget", [{ objectId: "w1", values: { status: "final" } }]);
    return adapter.resolveProperties("test.Widget", "w1", []).then(({ values }) => {
      expect(values.status).toBe("final");
    });
  });
});
