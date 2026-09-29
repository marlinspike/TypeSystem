import { describe, it, expect } from "vitest";
import {
  SemanticRegistry,
  InMemoryRegistryStore,
  SemanticRuntime,
  AbacPolicyEngine,
  allowAllRule,
  UnsupportedResolutionError,
  type Identity,
  type SemanticTypeSchema,
  type SemanticRuntimeOptions
} from "@typesys/core";
import { InMemoryRepositoryAdapter } from "../src/in-memory-repository-adapter.js";

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

async function setup(runtimeOptions?: SemanticRuntimeOptions) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());

  const aircraft: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Aircraft/1.0.0",
    title: "Aircraft",
    type: "object",
    properties: { tail: { type: "string" }, homeBase: { type: "string" } },
    "x-relationships": {
      // Many-to-many through an association collection (join table).
      crew: { target: "test.Crew", cardinality: "many-to-many", resolution: { dataSourceId: "mem", operation: "byJoinTable:test.Assignment/aircraftId/crewId" } },
      // Composite-key self relationship: other aircraft sharing this one's home base.
      basemates: { target: "test.Aircraft", cardinality: "one-to-many", resolution: { dataSourceId: "mem", operation: "byCompositeKey:homeBase=homeBase" } },
      // A large one-to-many, for the fan-out cap test.
      components: { target: "test.Component", cardinality: "one-to-many", resolution: { dataSourceId: "mem", operation: "byForeignKey:aircraftId" } },
      // A join whose association lives in another data source — this adapter can't cross sources.
      crewCross: { target: "test.Crew", cardinality: "many-to-many", resolution: { dataSourceId: "mem", operation: "byJoinTable:other@test.Assignment/aircraftId/crewId" } }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(aircraft, { name: "test.Aircraft", version: "1.0.0" });

  for (const [name, id] of [["test.Crew", "Crew"], ["test.Component", "Component"]] as const) {
    const schema: SemanticTypeSchema = {
      $id: `https://typesys.dev/types/test/${id}/1.0.0`,
      title: id,
      type: "object",
      properties: { name: { type: "string" }, aircraftId: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(schema, { name, version: "1.0.0" });
  }

  for (const typeName of ["test.Aircraft", "test.Crew", "test.Component"]) {
    await registry.registerMapping({ id: `map-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId: "mem", operation: "get", resolutionMode: "live" });
  }

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);

  const adapter = new InMemoryRepositoryAdapter("mem");
  adapter.seed("test.Aircraft", [
    { objectId: "a1", values: { tail: "AF1", homeBase: "Langley" } },
    { objectId: "a2", values: { tail: "AF2", homeBase: "Langley" } },
    { objectId: "a3", values: { tail: "AF3", homeBase: "Nellis" } }
  ]);
  adapter.seed("test.Crew", [
    { objectId: "c1", values: { name: "Alice" } },
    { objectId: "c2", values: { name: "Bob" } }
  ]);
  // Association rows (not a registered Type — just the join collection this adapter reads keys from).
  adapter.seed("test.Assignment", [
    { objectId: "as1", values: { aircraftId: "a1", crewId: "c1" } },
    { objectId: "as2", values: { aircraftId: "a1", crewId: "c2" } },
    { objectId: "as3", values: { aircraftId: "a2", crewId: "c1" } }
  ]);
  adapter.seed(
    "test.Component",
    Array.from({ length: 5 }, (_, i) => ({ objectId: `comp${i}`, values: { aircraftId: "a1" } }))
  );

  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, runtimeOptions);
  return { runtime };
}

const ids = (objs: { objectId: string }[]) => objs.map((o) => o.objectId).sort();

describe("Relationship resolution strategies (ADR-0028)", () => {
  it("resolves a many-to-many relationship through a join table", async () => {
    const { runtime } = await setup();
    const crew = await runtime.getRelationship("test.Aircraft", "a1", "crew", identity);
    expect(ids(crew)).toEqual(["c1", "c2"]);
    const crewOfA2 = await runtime.getRelationship("test.Aircraft", "a2", "crew", identity);
    expect(ids(crewOfA2)).toEqual(["c1"]);
  });

  it("resolves a composite-key relationship", async () => {
    const { runtime } = await setup();
    const mates = await runtime.getRelationship("test.Aircraft", "a1", "basemates", identity);
    expect(ids(mates)).toEqual(["a1", "a2"]); // both Langley aircraft (a1 matches itself); a3 (Nellis) excluded
  });

  it("rejects a join whose association lives in another data source", async () => {
    const { runtime } = await setup();
    await expect(runtime.getRelationship("test.Aircraft", "a1", "crewCross", identity)).rejects.toBeInstanceOf(UnsupportedResolutionError);
  });

  it("caps a large one-to-many at maxRelatedPerObject", async () => {
    const { runtime } = await setup({ queryLimits: { maxRelatedPerObject: 2 } });
    const components = await runtime.getRelationship("test.Aircraft", "a1", "components", identity);
    expect(components).toHaveLength(2); // 5 seeded, capped to 2
  });

  it("applies include-level sort and limit", async () => {
    const { runtime } = await setup();
    const r = await runtime.query(
      { type: "test.Aircraft", filter: { property: "tail", operator: "eq", value: "AF1" }, include: [{ relationship: "crew", sort: [{ property: "name", direction: "desc" }], limit: 1 }] },
      identity
    );
    const crew = r.items[0]!.values.crew as { values: Record<string, unknown> }[];
    expect(crew).toHaveLength(1);
    expect(crew[0]!.values.name).toBe("Bob"); // desc by name → Bob before Alice → limit 1
  });
});
