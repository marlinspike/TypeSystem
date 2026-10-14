import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type SemanticRuntimeOptions } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter } from "../src/runtime/adapter.js";
import type { Identity } from "../src/model/policy.js";

/**
 * Adversarial review of ADR-0068 (need-to-know discovery). Each test asserts
 * the secure behavior: nothing sent to a caller names a Type, member or
 * Action need-to-know withholds from them.
 */
class Store implements Adapter {
  readonly dataSourceId = "ds";
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

async function world(options: SemanticRuntimeOptions = { discovery: "need-to-know" }) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  // A Type only the "secret" role may know of.
  await registry.registerType(
    { $id: "https://typesys.dev/types/test/Compartment/1.0.0", type: "object", title: "Compartment", properties: { id: { type: "string" } }, "x-policy": { objectPolicy: "secret.only" } },
    { name: "test.Compartment", version: "1.0.0" }
  );
  // A public Type, deprecated in favor of the withheld one.
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Public/1.0.0",
      type: "object",
      title: "Public",
      properties: { id: { type: "string" }, codename: { type: "string" } },
      "x-policy": { objectPolicy: "anyone", propertyPolicies: { codename: "secret.only" } }
    },
    { name: "test.Public", version: "1.0.0", deprecated: { since: "1.0.0", supersededBy: "test.Compartment" } }
  );
  await registry.registerMapping({ id: "m1", typeName: "test.Public", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  await registry.registerMapping({ id: "m2", typeName: "test.Compartment", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  const action = (name: string, policy: string, extra: object = {}) => ({
    id: name,
    name,
    version: "1.0.0",
    description: `${name}.`,
    applicableTypes: ["test.Public"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authorizationPolicy: policy,
    preconditions: [{ description: `Only during exercise OPERATION-NIGHTJAR (${name})`, check: async () => true }],
    implementation: { dataSourceId: "ds", operation: name },
    sideEffects: "mutates" as const,
    idempotency: "natural" as const,
    auditRequired: true,
    ...extra
  });
  await registry.registerAction(action("test.CompartmentPromote", "secret.only"));
  await registry.registerAction(action("test.Promote", "anyone", { deprecated: { since: "1.0.0", supersededBy: "test.CompartmentPromote" } }));
  const engine = new AbacPolicyEngine();
  engine.registerRule("anyone", allowAllRule);
  engine.registerRule("secret.only", requireRole("secret"));
  return { registry, runtime: new SemanticRuntime(registry, [new Store()], engine, options) };
}

describe("ADR-0068 adversarial: need-to-know", () => {
  it("sanity: the viewer is told test.Public and test.Promote, not test.Compartment, codename or test.CompartmentPromote", async () => {
    const { runtime } = await world();
    const model = await runtime.describeModel(viewer);
    expect(model.types.map((t) => t.name)).toEqual(["test.Public"]);
    expect(model.actions.map((a) => a.name)).toEqual(["test.Promote"]);
  });

  it("a Type's deprecated.supersededBy never names a withheld Type", async () => {
    const { runtime } = await world();
    const text = JSON.stringify(await runtime.describeModel(viewer));
    expect(text).not.toContain("test.Compartment\"");
  });

  it("an Action's deprecated.supersededBy never names a withheld Action", async () => {
    const { runtime } = await world();
    const text = JSON.stringify(await runtime.describeModel(viewer));
    expect(text).not.toContain("test.CompartmentPromote");
  });

  it("previewAction does not tell an anonymous caller about an Action (listActions refuses them)", async () => {
    const { runtime } = await world();
    await expect(runtime.listActions("test.Public", anonymous)).rejects.toThrow(AuthorizationError);
    await expect(runtime.previewAction("test.CompartmentPromote", {}, anonymous)).rejects.toThrow();
  });

  it("previewAction does not tell a viewer a withheld Action's preconditions, effects or the roles its policy wants", async () => {
    const { runtime } = await world();
    let text = "";
    try {
      text = JSON.stringify(await runtime.previewAction("test.CompartmentPromote", {}, viewer));
    } catch (err) {
      text = String((err as Error).message) + String((err as AuthorizationError).reason ?? "");
    }
    expect(text).not.toContain("NIGHTJAR");
    expect(text).not.toContain("secret");
  });

  it("an identity with no subject id is not treated as authenticated", async () => {
    const { runtime } = await world({ discovery: "authenticated" });
    await expect(runtime.describeModel({ roles: [], attributes: {} } as unknown as Identity)).rejects.toThrow(AuthorizationError);
  });
});
