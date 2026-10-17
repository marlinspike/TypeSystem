import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, requireRole } from "../src/policy/abac-policy-engine.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import type { Adapter, AdapterQueryResult, ResolvedProperties } from "../src/runtime/adapter.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";
import type { ComputeContext } from "../src/model/context.js";

/**
 * ADR-0060: a subtype keeps its base's protections. Before it, `test.Jet`
 * extending `test.Craft` and naming only an object policy gave every reader
 * the officers-only `status`, the SECRET `location`, and `readiness`, which
 * is computed from `status` and withheld on the base (ADR-0052).
 */
class Repo implements Adapter {
  readonly dataSourceId = "ds";
  readonly rows: Record<string, Record<string, unknown>> = {
    "test.Craft/C-1": { id: "C-1", tail: "C-1", status: "down", location: "Base X" },
    "test.Jet/J-1": { id: "J-1", tail: "J-1", status: "down", location: "Base X", block: 52 }
  };
  async resolveProperties(typeName: string, id: string): Promise<ResolvedProperties> {
    return { values: { ...this.rows[`${typeName}/${id}`] }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship() {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const officer: Identity = { subjectId: "officer", roles: ["officer", "reader"], attributes: {}, clearance: "SECRET" };
const reader: Identity = { subjectId: "reader", roles: ["reader"], attributes: {}, clearance: "CUI" };

const jet = (extra: Partial<SemanticTypeSchema> = {}): SemanticTypeSchema => ({
  $id: "https://typesys.dev/types/test/Jet/1.0.0",
  title: "Jet",
  type: "object",
  properties: { block: { type: "integer" } },
  ...extra
});

async function setup(jetSchema: SemanticTypeSchema) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const computedImplementations = { readiness: async (ctx: ComputeContext) => (String(await ctx.getProperty("status")) === "down" ? "NMC" : "FMC") };
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Craft/1.0.0",
      title: "Craft",
      type: "object",
      properties: { id: { type: "string" }, tail: { type: "string" }, status: { type: "string" }, location: { type: "string" } },
      "x-computed": { readiness: { dependsOn: ["status"], binding: "readiness" } },
      "x-policy": { objectPolicy: "read", propertyPolicies: { status: "officers" } },
      "x-provenance": { properties: { location: { classification: "SECRET" } } }
    },
    { name: "test.Craft", version: "1.0.0", computedImplementations }
  );
  await registry.registerType(jetSchema, { name: "test.Jet", version: "1.0.0", extends: "test.Craft", computedImplementations });
  for (const typeName of ["test.Craft", "test.Jet"])
    await registry.registerMapping({ id: `m-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  const policy = new AbacPolicyEngine();
  policy.registerRule("read", requireRole("reader"));
  policy.registerRule("officers", requireRole("officer"));
  policy.registerRule("anyone", async () => ({ allow: true, reason: "anyone" }));
  return { registry, runtime: new SemanticRuntime(registry, [new Repo()], policy, { classification: DEMO_LINEAR_CLASSIFICATION }) };
}

const visible = async (runtime: SemanticRuntime, type: string, id: string, who: Identity) => Object.keys((await runtime.getObject(type, id, who)).values).sort();

describe("a subtype keeps its base's protections (ADR-0060)", () => {
  it("withholds from a reader what the base withholds, though the subtype names only an object policy", async () => {
    const { runtime } = await setup(jet({ "x-policy": { objectPolicy: "read" } }));
    expect(await visible(runtime, "test.Craft", "C-1", reader)).toEqual(["id", "tail"]);
    expect(await visible(runtime, "test.Jet", "J-1", reader)).toEqual(["block", "id", "tail"]);
    expect(await visible(runtime, "test.Jet", "J-1", officer)).toEqual(["block", "id", "location", "readiness", "status", "tail"]);
  });

  it("applies the base's object policy when the subtype names none", async () => {
    const { runtime } = await setup(jet());
    expect(await visible(runtime, "test.Jet", "J-1", reader)).toEqual(["block", "id", "tail"]);
    await expect(runtime.getObject("test.Jet", "J-1", { subjectId: "nobody", roles: [], attributes: {} })).rejects.toThrow(/Not authorized/);
  });

  it("keeps the base's marking on every object of the subtype", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const marked = { $id: "https://typesys.dev/types/test/Secret/1.0.0", title: "Secret", type: "object", properties: { tail: { type: "string" } }, "x-policy": { objectPolicy: "read" }, "x-provenance": { defaultClassification: "SECRET" } } as SemanticTypeSchema;
    await registry.registerType(marked, { name: "test.Secret", version: "1.0.0" });
    const sub = await registry.registerType({ ...jet(), $id: "https://typesys.dev/types/test/SubSecret/1.0.0" }, { name: "test.SubSecret", version: "1.0.0", extends: "test.Secret" });
    expect(sub.schema["x-provenance"]).toEqual({ defaultClassification: "SECRET" });
    await expect(registry.registerType({ ...jet(), $id: "https://typesys.dev/types/test/Open/1.0.0", "x-provenance": { defaultClassification: "UNCLASSIFIED" } }, { name: "test.Open", version: "1.0.0", extends: "test.Secret" })).rejects.toThrow(
      /would replace the Type's classification "SECRET"/
    );
  });

  it("lets a subtype add protections, and refuses one that would replace the base's", async () => {
    const { runtime } = await setup(jet({ "x-policy": { propertyPolicies: { block: "officers", status: "officers" } }, "x-provenance": { properties: { block: { classification: "SECRET" } } } }));
    expect(await visible(runtime, "test.Jet", "J-1", reader)).toEqual(["id", "tail"]);

    await expect(setup(jet({ "x-provenance": { defaultClassification: "CUI" } }))).resolves.toBeDefined();
    await expect(setup(jet({ "x-policy": { propertyPolicies: { status: "anyone" } } }))).rejects.toThrow(/would replace the policy "officers" on "status"/);
    await expect(setup(jet({ "x-provenance": { properties: { location: { classification: "UNCLASSIFIED" } } } }))).rejects.toThrow(/would replace the classification "SECRET" on "location"/);
  });

  it("follows a later version of the base: gains its new protections, keeps ones it drops, and refuses one that would replace a subtype's own", async () => {
    const schema = (v: string, extra: Partial<SemanticTypeSchema>): SemanticTypeSchema => ({ $id: `https://typesys.dev/types/test/B/${v}`, title: "B", type: "object", ...extra });
    const store = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(store);
    await registry.registerType(schema("1.0.0", { "x-policy": { objectPolicy: "readers", propertyPolicies: { a: "officers" } } }), { name: "test.B", version: "1.0.0" });
    await registry.registerType({ $id: "https://typesys.dev/types/test/S/1.0.0", title: "S", type: "object", "x-policy": { propertyPolicies: { own: "officers" } } }, { name: "test.S", version: "1.0.0", extends: "test.B" });
    await registry.registerType({ $id: "https://typesys.dev/types/test/G/1.0.0", title: "G", type: "object" }, { name: "test.G", version: "1.0.0", extends: "test.S" });

    // 2.0.0 drops `a`'s policy and adds `b`'s: every subtype, the grand-child too, has both.
    await registry.registerType(schema("2.0.0", { "x-policy": { objectPolicy: "readers", propertyPolicies: { b: "officers" } }, "x-provenance": { properties: { c: { classification: "SECRET" } } } }), { name: "test.B", version: "2.0.0" });
    for (const name of ["test.S", "test.G"]) {
      const sub = await registry.getType(name);
      expect(sub?.schema["x-policy"]).toEqual({ objectPolicy: "readers", propertyPolicies: { a: "officers", b: "officers", own: "officers" } });
      expect(sub?.schema["x-provenance"]?.properties?.c?.classification).toBe("SECRET");
    }

    // A base version that would replace a subtype's own rule is refused, and nothing is stored.
    await expect(
      registry.registerType(schema("3.0.0", { "x-policy": { objectPolicy: "readers", propertyPolicies: { own: "anyone" } } }), { name: "test.B", version: "3.0.0" })
    ).rejects.toThrow(/would replace the policy "anyone" on "own"/);
    expect((await registry.getType("test.B"))?.version).toBe("2.0.0");
  });
});
