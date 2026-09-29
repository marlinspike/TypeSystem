import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { InvalidInputError } from "../src/runtime/errors.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";
import type { Cache } from "../src/runtime/cache.js";

/** Owner -> pets (Pet) -> toys (Toy), resolved by `byForeignKey:<field>` like the shipped adapters. */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Owner": { o1: { id: "o1", name: "Ada" } },
  "test.Pet": {
    p1: { id: "p1", ownerId: "o1", species: "cat", microchip: "MC-1" },
    p2: { id: "p2", ownerId: "o1", species: "dog", microchip: "MC-2" },
    p3: { id: "p3", ownerId: "o1", species: "cat", microchip: "MC-3" }
  },
  "test.Toy": {
    t1: { id: "t1", petId: "p1", kind: "ball" },
    t2: { id: "t2", petId: "p1", kind: "mouse" },
    t3: { id: "t3", petId: "p3", kind: "ball" }
  }
};

class GraphAdapter implements Adapter {
  readonly dataSourceId = "graph-ds";

  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    return { values: { ...(DATA[typeName]?.[objectId] ?? {}) }, provenance: [] };
  }

  async queryByType(typeName: string): Promise<AdapterQueryResult> {
    const items = Object.entries(DATA[typeName] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] }));
    return { items };
  }

  async resolveRelationship(relationship: RelationshipDefinition, objectId: string): Promise<RelatedRef[]> {
    const field = relationship.resolution.operation.replace("byForeignKey:", "");
    return Object.entries(DATA[relationship.targetType] ?? {})
      .filter(([, values]) => values[field] === objectId)
      .map(([id]) => ({ objectId: id }));
  }

  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return input;
  }
}

const vet: Identity = { subjectId: "vet", roles: ["vet"], attributes: {} };
const visitor: Identity = { subjectId: "visitor", roles: [], attributes: {} };

async function registerType(registry: SemanticRegistry, name: string, schema: Omit<SemanticTypeSchema, "$id" | "type">) {
  const short = name.split(".")[1]!;
  await registry.registerType(
    { $id: `https://typesys.dev/types/test/${short}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema,
    { name, version: "1.0.0", computedImplementations: { isCat: async (ctx) => (await ctx.getProperty("species")) === "cat" } }
  );
  await registry.registerMapping({
    id: `map-${short}`,
    typeName: name,
    target: "property",
    targetName: "*",
    dataSourceId: "graph-ds",
    operation: "get",
    resolutionMode: "live"
  });
}

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerType(registry, "test.Toy", {
    title: "Toy",
    properties: { id: { type: "string" }, petId: { type: "string" }, kind: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  });
  await registerType(registry, "test.Pet", {
    title: "Pet",
    properties: { id: { type: "string" }, ownerId: { type: "string" }, species: { type: "string" }, microchip: { type: "string" } },
    "x-relationships": {
      toys: { target: "test.Toy", cardinality: "one-to-many", resolution: { dataSourceId: "graph-ds", operation: "byForeignKey:petId" } }
    },
    // `isCat` is computed, so it only exists after resolution: fine for include filters, which run then.
    "x-computed": { isCat: { dependsOn: ["species"], binding: "isCat" } },
    // `microchip` is visible only to vets — the property an include filter must not be able to probe.
    "x-policy": { objectPolicy: "public", propertyPolicies: { microchip: "vet-only" } }
  });
  await registerType(registry, "test.Owner", {
    title: "Owner",
    properties: { id: { type: "string" }, name: { type: "string" } },
    "x-relationships": {
      pets: { target: "test.Pet", cardinality: "one-to-many", resolution: { dataSourceId: "graph-ds", operation: "byForeignKey:ownerId" } }
    },
    "x-policy": { objectPolicy: "public" }
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("vet-only", requireRole("vet"));
  return new SemanticRuntime(registry, [new GraphAdapter()], policyEngine);
}

type Obj = { objectId: string; values: Record<string, unknown> };
const ids = (objs: unknown) => (objs as Obj[]).map((o) => o.objectId).sort();

describe("Query include filters and nested includes (ADR-0011)", () => {
  it("applies an include-level filter to the related objects", async () => {
    const runtime = await setup();
    const { items } = await runtime.query(
      { type: "test.Owner", include: [{ relationship: "pets", filter: { property: "species", operator: "eq", value: "cat" } }] },
      vet
    );
    expect(ids(items[0]!.values.pets)).toEqual(["p1", "p3"]);
  });

  it("resolves a nested include from each related object", async () => {
    const runtime = await setup();
    const { items } = await runtime.query(
      { type: "test.Owner", include: [{ relationship: "pets", include: [{ relationship: "toys" }] }] },
      vet
    );
    const pets = items[0]!.values.pets as Obj[];
    const toysByPet = Object.fromEntries(pets.map((p) => [p.objectId, ids(p.values.toys)]));
    expect(toysByPet).toEqual({ p1: ["t1", "t2"], p2: [], p3: ["t3"] });
  });

  it("combines filters at both levels", async () => {
    const runtime = await setup();
    const { items } = await runtime.query(
      {
        type: "test.Owner",
        include: [
          {
            relationship: "pets",
            filter: { property: "species", operator: "eq", value: "cat" },
            include: [{ relationship: "toys", filter: { property: "kind", operator: "eq", value: "ball" } }]
          }
        ]
      },
      vet
    );
    const pets = items[0]!.values.pets as Obj[];
    expect(Object.fromEntries(pets.map((p) => [p.objectId, ids(p.values.toys)]))).toEqual({ p1: ["t1"], p3: ["t3"] });
  });

  it("evaluates include filters on redacted values, so a hidden property can't be probed", async () => {
    const runtime = await setup();
    const probe = { type: "test.Owner", include: [{ relationship: "pets", filter: { property: "microchip", operator: "eq" as const, value: "MC-2" } }] };

    const asVet = await runtime.query(probe, vet);
    expect(ids(asVet.items[0]!.values.pets)).toEqual(["p2"]);

    // A caller who can't read `microchip` gets no match, not a yes/no oracle on its value.
    const asVisitor = await runtime.query(probe, visitor);
    expect(ids(asVisitor.items[0]!.values.pets)).toEqual([]);
  });

  it("can filter an include on a computed property, since include filters run after resolution", async () => {
    const runtime = await setup();
    const { items } = await runtime.query(
      { type: "test.Owner", include: [{ relationship: "pets", filter: { property: "isCat", operator: "eq", value: true } }] },
      vet
    );
    expect(ids(items[0]!.values.pets)).toEqual(["p1", "p3"]);
  });

  it("rejects the same relationship twice at one level (results are keyed by name)", async () => {
    const runtime = await setup();
    await expect(
      runtime.query({ type: "test.Owner", include: [{ relationship: "pets" }, { relationship: "pets" }] }, vet)
    ).rejects.toThrow(/included twice/);
  });

  it("rejects includes nested deeper than maxIncludeDepth", async () => {
    const runtime = await setup();
    const tooDeep = { relationship: "pets", include: [{ relationship: "toys", include: [{ relationship: "x", include: [{ relationship: "y" }] }] }] };
    await expect(runtime.query({ type: "test.Owner", include: [tooDeep] }, vet)).rejects.toThrow(/include nesting depth 4/);
  });

  it("counts maxIncludes across every level, not per level", async () => {
    const runtime = await setup();
    const perLevel = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ relationship: `${prefix}${i}` }));
    // 6 top-level + 5 nested = 11 > the default 10, though no single level exceeds it.
    const include = [...perLevel(5, "a"), { relationship: "pets", include: perLevel(5, "b") }];
    await expect(runtime.query({ type: "test.Owner", include }, vet)).rejects.toThrow(/more than 10 include entries/);
    await expect(runtime.query({ type: "test.Owner", include }, vet)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("applies filter limits to include-level filters too", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const runtime = new SemanticRuntime(registry, [], new AbacPolicyEngine(), { queryLimits: { maxFilterConditions: 1 } });
    const cond = { property: "species", operator: "eq" as const, value: "cat" };
    await expect(
      runtime.query({ type: "test.Owner", include: [{ relationship: "pets", filter: { and: [cond, cond] } }] }, vet)
    ).rejects.toThrow(/include\.pets filter has 2 conditions/);
  });
});

describe("SemanticRuntime options object", () => {
  it("fails loudly when a Cache is passed where the options object now goes", () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const legacyPositional = new InMemoryCache() as unknown as { cache?: Cache };
    expect(() => new SemanticRuntime(registry, [], new AbacPolicyEngine(), legacyPositional)).toThrow(/options object/);
  });
});
