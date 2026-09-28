import { describe, it, expect } from "vitest";
import { buildRuntime } from "../src/registry/build-runtime.js";
import { coreManifest } from "../src/base/manifest.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { ActionContext } from "../src/model/context.js";
import type { Identity } from "../src/model/policy.js";

class NoopAdapter implements Adapter {
  readonly dataSourceId = "noop-ds";
  async resolveProperties(): Promise<ResolvedProperties> {
    return { values: { id: "party-1", displayName: "Ada Lovelace" }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(_action: ActionDefinition, input: unknown, _ctx: ActionContext): Promise<unknown> {
    return input;
  }
}

const viewer: Identity = { subjectId: "u1", roles: ["viewer"], attributes: {} };

describe("buildRuntime", () => {
  it("wires a registry + policy engine + runtime from manifests, adapters, and named policy rules in one call", async () => {
    const { registry, runtime } = await buildRuntime({
      manifests: [coreManifest],
      adapters: [new NoopAdapter()],
      policyRules: { "allow-viewer": (req) => ({ allow: req.subject.roles.includes("viewer") }) }
    });

    // The registry actually registered core's types (manifest registration happened).
    expect((await registry.listTypes()).map((t) => t.name)).toContain("core.Party");

    // Registering a domain-neutral type with the named policy rule proves the
    // policy engine and runtime are actually wired together, not just constructed.
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Thing/1.0.0",
        title: "Thing",
        type: "object",
        "x-policy": { objectPolicy: "allow-viewer" }
      },
      { name: "test.Thing", version: "1.0.0" }
    );
    await registry.registerMapping({
      id: "map-1",
      typeName: "test.Thing",
      target: "property",
      targetName: "*",
      dataSourceId: "noop-ds",
      operation: "get",
      resolutionMode: "live"
    });

    const object = await runtime.getObject("test.Thing", "party-1", viewer);
    expect(object.values.displayName).toBe("Ada Lovelace");

    const anonymous: Identity = { subjectId: "anon", roles: [], attributes: {} };
    await expect(runtime.getObject("test.Thing", "party-1", anonymous)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("defaults to an in-memory store and a fresh ABAC policy engine when none are supplied", async () => {
    const { registry } = await buildRuntime({ manifests: [], adapters: [] });
    expect(await registry.listTypes()).toEqual([]);
  });

  it("accepts a caller-supplied PolicyEngine instead of building an ABAC one, and the runtime actually calls it", async () => {
    let evaluateCallCount = 0;
    const customEngine = {
      evaluate: async () => {
        evaluateCallCount++;
        return { allow: true };
      }
    };
    const { registry, runtime, policyEngine } = await buildRuntime({
      manifests: [coreManifest],
      adapters: [new NoopAdapter()],
      policyEngine: customEngine
    });
    expect(policyEngine).toBe(customEngine);

    await registry.registerMapping({
      id: "map-party",
      typeName: "core.Party",
      target: "property",
      targetName: "*",
      dataSourceId: "noop-ds",
      operation: "get",
      resolutionMode: "live"
    });

    await runtime.getObject("core.Party", "party-1", viewer);
    expect(evaluateCallCount).toBe(1); // the object-level policy check went through the SUPPLIED engine, not a default one
  });
});
