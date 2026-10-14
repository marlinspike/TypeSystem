import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter } from "../src/runtime/adapter.js";
import type { Identity } from "../src/model/policy.js";

/**
 * Pressure test 3 of ADR-0068 (need-to-know discovery). "What the caller is
 * sent never names what it withholds", and an anonymous caller is refused
 * any description of the model under `authenticated` and `need-to-know`.
 */
class Store implements Adapter {
  readonly dataSourceId = "ds-compartment-feed";
  async resolveProperties() {
    return { values: {}, provenance: [] };
  }
  async queryByType() {
    return { items: [] };
  }
  async resolveRelationship() {
    return [];
  }
  async executeAction() {
    return {};
  }
}

const viewer: Identity = { subjectId: "user-viewer", roles: ["viewer"], attributes: {} };
const anonymous: Identity = { subjectId: "anonymous", roles: [], attributes: {} };
const COMPARTMENT_ID = "https://typesys.dev/types/test/Compartment/1.0.0";

async function world(options: SemanticRuntimeOptions = { discovery: "need-to-know" }) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  // A Type only the "secret" role may know of.
  await registry.registerType(
    { $id: COMPARTMENT_ID, type: "object", title: "Compartment", properties: { id: { type: "string" }, codeword: { type: "string" } }, "x-policy": { objectPolicy: "secret.only" } },
    { name: "test.Compartment", version: "1.0.0" }
  );
  // A public Type with a member only "secret" may know of, and a computed value over it.
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Public/1.0.0",
      type: "object",
      title: "Public",
      properties: {
        id: { type: "string" },
        codename: { type: "string" },
        // A public value whose schema refers to the withheld Type.
        owner: { $ref: COMPARTMENT_ID }
      },
      "x-computed": { codenameLength: { dependsOn: ["codename"], binding: "len", schema: { type: "integer" }, resolutionMode: "live" } },
      "x-policy": { objectPolicy: "anyone", propertyPolicies: { codename: "secret.only" } }
    },
    { name: "test.Public", version: "1.0.0", computedImplementations: { len: async () => 0 } }
  );
  await registry.registerMapping({ id: "m1", typeName: "test.Public", target: "property", targetName: "*", dataSourceId: "ds-compartment-feed", operation: "get", resolutionMode: "live" });
  await registry.registerMapping({ id: "m2", typeName: "test.Compartment", target: "property", targetName: "*", dataSourceId: "ds-compartment-feed", operation: "get", resolutionMode: "live" });
  await registry.registerAction({
    id: "test.Promote",
    name: "test.Promote",
    version: "1.0.0",
    description: "Promote.",
    applicableTypes: ["test.Public"],
    inputSchema: { type: "object" },
    // Returns the withheld Type.
    outputSchema: { $ref: COMPARTMENT_ID },
    authorizationPolicy: "anyone",
    implementation: { dataSourceId: "ds-compartment-feed", operation: "promote" },
    sideEffects: "mutates",
    idempotency: "natural",
    auditRequired: true
  });
  // Applies to both Types and acts on a Compartment: need-to-know withholds it from whoever may not read one.
  await registry.registerAction({
    id: "test.Seal",
    name: "test.Seal",
    version: "1.0.0",
    description: "Seal a compartment.",
    applicableTypes: ["test.Public", "test.Compartment"],
    target: { type: "test.Compartment", idFrom: "compartmentId" },
    inputSchema: { type: "object", properties: { compartmentId: { type: "string" } }, required: ["compartmentId"] },
    outputSchema: { type: "object" },
    authorizationPolicy: "anyone",
    implementation: { dataSourceId: "ds-compartment-feed", operation: "seal" },
    sideEffects: "mutates",
    idempotency: "natural",
    auditRequired: true
  });
  const engine = new AbacPolicyEngine();
  engine.registerRule("anyone", allowAllRule);
  engine.registerRule("secret.only", requireRole("secret"));
  return { registry, runtime: new SemanticRuntime(registry, [new Store()], engine, options) };
}

async function told(f: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await f());
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
}

describe("p3: need-to-know discovery (ADR-0068)", () => {
  it("held: describeModel withholds test.Compartment, codename and codenameLength from the viewer", async () => {
    const { runtime } = await world();
    const model = await runtime.describeModel(viewer);
    expect(model.types.map((t) => t.name)).toEqual(["test.Public"]);
    expect(Object.keys(model.types[0]!.properties)).not.toContain("codename");
    expect(model.types[0]!.computed.map((c) => c.name)).toEqual([]);
  });

  it("P3-D1: explainQuery refuses an anonymous caller under need-to-know, as describeModel does", async () => {
    const { runtime } = await world();
    await expect(runtime.describeModel(anonymous)).rejects.toThrow(/Not authorized/);
    const text = await told(() => runtime.explainQuery({ type: "test.Public" }, anonymous));
    // Observed: a full execution plan, with the data source, the policy names and every member.
    expect(text).not.toContain("codename");
    expect(text).not.toContain("ds-compartment-feed");
  });

  it("P3-D2: explainQuery of a withheld Type is answered as for a Type that does not exist", async () => {
    const { runtime } = await world();
    const withheld = await told(() => runtime.explainQuery({ type: "test.Compartment" }, viewer));
    const missing = await told(() => runtime.explainQuery({ type: "test.Nothing" }, viewer));
    // Observed: a plan naming the Type's policy ("secret.only") and its source; an unknown Type is "Unknown type".
    expect(withheld.replaceAll("test.Compartment", "test.Nothing")).toBe(missing);
  });

  it("P3-D3: explainQuery of a described Type does not name the members need-to-know withholds", async () => {
    const { runtime } = await world();
    const text = await told(() => runtime.explainQuery({ type: "test.Public" }, viewer));
    expect(text).toContain("scan");
    // Observed: the compute step names codenameLength (dependsOn codename) and the redact step names codename.
    expect(text).not.toContain("codename");
  });

  it("P3-D4: a described property's schema and a described Action's outputSchema do not name a withheld Type", async () => {
    const { runtime } = await world();
    const model = await runtime.describeModel(viewer);
    expect(model.actions.map((a) => a.name)).toEqual(["test.Promote"]);
    // Observed: both carry { $ref: ".../types/test/Compartment/1.0.0" }, as H5's allOf did.
    expect(JSON.stringify(model)).not.toContain("Compartment");
  });

  it("P3-D9: listActions names no Action that describeModel withholds (one acting on a withheld Type)", async () => {
    const { runtime } = await world();
    const described = (await runtime.describeModel(viewer)).actions.map((a) => a.name);
    expect(described).not.toContain("test.Seal");
    // Held: previewAction answers it as unknown.
    await expect(runtime.previewAction("test.Seal", { compartmentId: "C-1" }, viewer)).rejects.toThrow(/Unknown action/);
    // Observed: listed (and authorized) on test.Public, with and without an object.
    expect((await runtime.listActions("test.Public", viewer)).map((l) => l.action.name)).toEqual(described);
    expect((await runtime.listActions("test.Public", viewer, { objectId: "P-1" })).map((l) => l.action.name)).toEqual(described);
  });
});
