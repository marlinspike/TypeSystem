import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AdapterTimeoutError, AdapterUnavailableError, AuthorizationError, CircuitOpenError, SourceRefusedError } from "../src/runtime/errors.js";
import { describeModel } from "../src/registry/model-description.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Optional relationships (ADR-0072): when an include's source fails, the
 * object comes back without it and says what is missing and why. Only a
 * source failure, only on an optional relationship, and never as `[]`.
 */
const ANY: Identity = { subjectId: "u", roles: ["reader"], attributes: {} };

class Source implements Adapter {
  failure: Error | undefined;
  constructor(
    readonly dataSourceId: string,
    private readonly data: Record<string, Record<string, Record<string, unknown>>>
  ) {}
  resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ values: { ...(this.data[typeName]?.[objectId] ?? {}) }, provenance: [] });
  }
  queryByType(typeName: string): Promise<AdapterQueryResult> {
    return Promise.resolve({ items: Object.entries(this.data[typeName] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] })) });
  }
  resolveRelationship(relationship: RelationshipDefinition, objectId: string): Promise<RelatedRef[]> {
    if (this.failure) return Promise.reject(this.failure);
    const field = relationship.resolution.operation.replace("byForeignKey:", "");
    return Promise.resolve(Object.entries(this.data[relationship.targetType] ?? {}).filter(([, v]) => v[field] === objectId).map(([id]) => ({ objectId: id })));
  }
  executeAction(): Promise<unknown> {
    return Promise.reject(new Error("none"));
  }
}

async function setup() {
  const home = new Source("home", { "t.Ship": { s1: { name: "Endurance" } } });
  const crew = new Source("crew", { "t.Sailor": { c1: { shipId: "s1", name: "Worsley" } } });
  const cargo = new Source("cargo", { "t.Crate": { k1: { shipId: "s1", label: "tea" } } });
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const reg = async (name: string, ds: string, schema: Omit<SemanticTypeSchema, "$id" | "type">) => {
    await registry.registerType({ $id: `https://typesys.dev/types/t/${name}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, { name: `t.${name}`, version: "1.0.0" });
    await registry.registerMapping({ id: `m-${name}`, typeName: `t.${name}`, target: "property", targetName: "*", dataSourceId: ds, operation: "get", resolutionMode: "live" });
  };
  await reg("Sailor", "crew", { title: "Sailor", properties: { shipId: { type: "string" }, name: { type: "string" } }, "x-policy": { objectPolicy: "open" } });
  await reg("Crate", "cargo", { title: "Crate", properties: { shipId: { type: "string" }, label: { type: "string" } }, "x-policy": { objectPolicy: "readers" } });
  await reg("Ship", "home", {
    title: "Ship",
    properties: { name: { type: "string" } },
    "x-relationships": {
      sailors: { target: "t.Sailor", cardinality: "one-to-many", resolution: { dataSourceId: "crew", operation: "byForeignKey:shipId" }, optional: true },
      crates: { target: "t.Crate", cardinality: "one-to-many", resolution: { dataSourceId: "cargo", operation: "byForeignKey:shipId" } }
    },
    "x-policy": { objectPolicy: "open" }
  });
  const policy = new AbacPolicyEngine();
  policy.registerRule("open", allowAllRule);
  policy.registerRule("readers", requireRole("reader"));
  const runtime = new SemanticRuntime(registry, [home, crew, cargo], policy);
  return { runtime, registry, crew, cargo };
}

const q = (include: string[]) => ({ type: "t.Ship", include: include.map((relationship) => ({ relationship })) });

describe("optional relationships (ADR-0072)", () => {
  it("each kind of source failure is left out and named; the rest of the answer arrives", async () => {
    const cases: [Error, string][] = [
      [new AdapterUnavailableError("crew down"), "unavailable"],
      [new AdapterTimeoutError("crew slow"), "timeout"],
      [new CircuitOpenError("crew breaker open"), "unavailable"],
      [new SourceRefusedError("crew refused our key", "crew"), "refused-by-source"]
    ];
    for (const [failure, reason] of cases) {
      const { runtime, crew } = await setup();
      crew.failure = failure;
      const [ship] = (await runtime.query(q(["sailors", "crates"]), ANY)).items;
      expect(ship!.values).not.toHaveProperty("sailors");
      expect(ship!.values.crates).toHaveLength(1);
      expect(ship!.unavailable).toEqual([{ path: "sailors", dataSourceId: "crew", reason, message: failure.message }]);
    }
  });

  it("a healthy optional include is returned as usual, with nothing reported missing", async () => {
    const { runtime } = await setup();
    const [ship] = (await runtime.query(q(["sailors"]), ANY)).items;
    expect(ship!.values.sailors).toHaveLength(1);
    expect(ship!).not.toHaveProperty("unavailable");
  });

  it("a required relationship still fails the read, and so does an optional one failing for any reason but its source", async () => {
    const { runtime, cargo, crew } = await setup();
    cargo.failure = new AdapterUnavailableError("cargo down");
    await expect(runtime.query(q(["crates"]), ANY)).rejects.toThrow("cargo down");
    cargo.failure = undefined;
    crew.failure = new Error("a bug in the adapter");
    await expect(runtime.query(q(["sailors"]), ANY)).rejects.toThrow("a bug in the adapter");
    crew.failure = new AuthorizationError("Not authorized: read t.Sailor/c1", "no");
    await expect(runtime.query(q(["sailors"]), ANY)).rejects.toThrow(AuthorizationError);
  });

  it("a direct read of the relationship still fails: the caller asked for exactly that", async () => {
    const { runtime, crew } = await setup();
    crew.failure = new AdapterUnavailableError("crew down");
    await expect(runtime.getRelationship("t.Ship", "s1", "sailors", ANY)).rejects.toThrow(AdapterUnavailableError);
  });

  it("the model says which relationships may be missing", async () => {
    const { registry } = await setup();
    const ship = (await describeModel(registry)).types.find((t) => t.name === "t.Ship")!;
    expect(ship.relationships).toEqual([
      { name: "sailors", target: "t.Sailor", cardinality: "one-to-many", optional: true },
      { name: "crates", target: "t.Crate", cardinality: "one-to-many" }
    ]);
  });
});
