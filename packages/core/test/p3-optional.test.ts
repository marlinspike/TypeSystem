import { describe, expect, it } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import { AdapterUnavailableError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Pressure test 3 (P3) of optional relationships (ADR-0072): a failure is
 * attributed to the source that failed, and a required relationship still
 * fails the read. Fails on the reviewed head (identical to PR #14).
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
  const kit = new Source("kit", { "t.Kit": { k1: { sailorId: "c1", label: "sextant" } } });
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const reg = async (name: string, ds: string, schema: Omit<SemanticTypeSchema, "$id" | "type">) => {
    await registry.registerType({ $id: `https://typesys.dev/types/t/${name}/1.0.0`, type: "object", ...schema } as SemanticTypeSchema, { name: `t.${name}`, version: "1.0.0" });
    await registry.registerMapping({ id: `m-${name}`, typeName: `t.${name}`, target: "property", targetName: "*", dataSourceId: ds, operation: "get", resolutionMode: "live" });
  };
  await reg("Kit", "kit", { title: "Kit", properties: { sailorId: { type: "string" }, label: { type: "string" } }, "x-policy": { objectPolicy: "open" } });
  await reg("Sailor", "crew", {
    title: "Sailor",
    properties: { shipId: { type: "string" }, name: { type: "string" } },
    // Required: when the kit store fails, a read that includes it fails (ADR-0072).
    "x-relationships": { kit: { target: "t.Kit", cardinality: "one-to-many", resolution: { dataSourceId: "kit", operation: "byForeignKey:sailorId" } } },
    "x-policy": { objectPolicy: "open" }
  });
  await reg("Ship", "home", {
    title: "Ship",
    properties: { name: { type: "string" } },
    "x-relationships": { sailors: { target: "t.Sailor", cardinality: "one-to-many", resolution: { dataSourceId: "crew", operation: "byForeignKey:shipId" }, optional: true } },
    "x-policy": { objectPolicy: "open" }
  });
  const policy = new AbacPolicyEngine();
  policy.registerRule("open", allowAllRule);
  const runtime = new SemanticRuntime(registry, [home, crew, kit], policy);
  return { runtime, crew, kit };
}

describe("P3 optional relationships", () => {
  it("P3-I3: a nested required include's failure is not reported as the optional parent's source being unavailable", async () => {
    const { runtime, kit } = await setup();
    kit.failure = new AdapterUnavailableError("kit store down");
    const result = await runtime
      .query({ type: "t.Ship", include: [{ relationship: "sailors", include: [{ relationship: "kit" }] }] }, ANY)
      .then((r) => ({ unavailable: r.items[0]?.unavailable }), (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    // ADR-0072: "A required relationship ... still fail[s] as before", and `unavailable` names the source that failed.
    // Today: { unavailable: [{ path: "sailors", dataSourceId: "crew", reason: "unavailable", message: "kit store down" }] }:
    // the crew source answered, yet it is named, and the required `kit` failure is swallowed.
    expect(result).toEqual({ error: "kit store down" });
  });
});
