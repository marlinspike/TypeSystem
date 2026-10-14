import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import type { Adapter, ResolvedProperties } from "../src/runtime/adapter.js";
import type { Identity } from "../src/model/policy.js";
import type { ComputeContext } from "../src/model/context.js";

/** ADR-0052 x ADR-0032: provenance of a value that is withheld by a (never-releasable) marking. */
const values: Record<string, unknown> = { name: "Alpha", location: "Base North" };
const adapter: Adapter = {
  dataSourceId: "ds",
  async resolveProperties(_t, id): Promise<ResolvedProperties> {
    return {
      values: { ...values },
      provenance: Object.keys(values).map((f) => ({ propertyPath: f, source: { dataSourceId: "ds", system: "unit-db", recordId: id, field: f }, retrievedAt: "2026-01-01T00:00:00.000Z" }))
    };
  },
  async queryByType() {
    return { items: [] };
  },
  async resolveRelationship() {
    return [];
  },
  async executeAction() {
    return undefined;
  }
};
const uncleared: Identity = { subjectId: "u", roles: ["reader"], attributes: {}, clearance: "UNCLASSIFIED" };

describe("ADR-0052 pressure: provenance of a value withheld by a marking", () => {
  it("[FINDING] getProvenance refuses a computed value that getObject withholds because a released input is marked", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/pv/Unit/1.0.0",
        title: "Unit",
        type: "object",
        properties: { name: { type: "string" }, location: { type: "string" } },
        "x-computed": { label: { dependsOn: ["name", "location"], binding: "label", releases: ["location"] } },
        "x-policy": { objectPolicy: "readers" },
        "x-provenance": { properties: { location: { classification: "SECRET" } } }
      },
      { name: "pv.Unit", version: "1.0.0", computedImplementations: { label: async (ctx: ComputeContext) => `${String(await ctx.getProperty("name"))}@${String(await ctx.getProperty("location"))}` } }
    );
    await registry.registerMapping({ id: "m", typeName: "pv.Unit", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    const policy = new AbacPolicyEngine();
    policy.registerRule("readers", requireRole("reader"));
    const runtime = new SemanticRuntime(registry, [adapter], policy, { classification: DEMO_LINEAR_CLASSIFICATION });

    // The value is withheld (markings are never released) ...
    expect((await runtime.getObject("pv.Unit", "u1", uncleared)).values).not.toHaveProperty("label");
    // ... so, per ADR-0052 "a withheld value's provenance is refused", its provenance must be too.
    await expect(runtime.getProvenance("pv.Unit", "u1", "label", uncleared)).rejects.toBeInstanceOf(AuthorizationError);
  });
});
