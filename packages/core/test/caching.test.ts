import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { ComputeContext } from "../src/model/context.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

class CountingAdapter implements Adapter {
  readonly dataSourceId = "counting-ds";
  resolveCount = 0;
  relationshipCount = 0;
  private readonly values: Record<string, unknown> = { id: "obj-1", name: "Widget One", secret: "s3cr3t" };
  private readonly related: RelatedRef[] = [{ objectId: "child-1" }];

  async resolveProperties(): Promise<ResolvedProperties> {
    this.resolveCount++;
    return { values: { ...this.values }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    this.relationshipCount++;
    return [...this.related];
  }
  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return input;
  }
}

const maintainer: Identity = { subjectId: "u-maintainer", roles: ["maintainer"], attributes: {} };
const viewer: Identity = { subjectId: "u-viewer", roles: ["viewer"], attributes: {} };

async function setup(resolutionMode: "live" | "cached", cacheTtlMs?: number) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Widget/1.0.0",
    title: "Widget",
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, secret: { type: "string" } },
    "x-relationships": {
      children: {
        target: "test.Widget",
        cardinality: "one-to-many",
        resolution: { dataSourceId: "counting-ds", operation: "byForeignKey:parentId" },
        resolutionMode,
        cacheTtlMs
      }
    },
    "x-policy": { objectPolicy: "public", propertyPolicies: { secret: "maintainer-only" } }
  };
  await registry.registerType(schema, { name: "test.Widget", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-1",
    typeName: "test.Widget",
    target: "property",
    targetName: "*",
    dataSourceId: "counting-ds",
    operation: "get",
    resolutionMode,
    cacheTtlMs
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("maintainer-only", requireRole("maintainer"));

  const adapter = new CountingAdapter();
  const cache = new InMemoryCache();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { cache, defaultCacheTtlMs: cacheTtlMs });

  return { registry, runtime, adapter, cache };
}

describe("Cached resolution mode (ADR-0016)", () => {
  it("live mode (default) never caches — every getObject call hits the adapter", async () => {
    const { runtime, adapter } = await setup("live");
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(2);
  });

  it("cached mode: a second getObject call within the TTL never touches the adapter", async () => {
    const { runtime, adapter } = await setup("cached", 5_000);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(1);
  });

  it("cached raw values are shared across identities, but each identity's redaction is still applied fresh", async () => {
    const { runtime, adapter } = await setup("cached", 5_000);

    const asMaintainer = await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(asMaintainer.values.secret).toBe("s3cr3t");

    const asViewer = await runtime.getObject("test.Widget", "obj-1", viewer);
    expect("secret" in asViewer.values).toBe(false); // still redacted for viewer...
    expect(asViewer.values.name).toBe("Widget One"); // ...even though the cached fetch served both

    expect(adapter.resolveCount).toBe(1); // one adapter call served both identities
  });

  it("expires after cacheTtlMs and re-fetches from the adapter", async () => {
    const { runtime, adapter } = await setup("cached", 20);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 40));

    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(2);
  });

  it("caches relationship resolution the same way", async () => {
    const { runtime, adapter } = await setup("cached", 5_000);
    await runtime.getRelationship("test.Widget", "obj-1", "children", maintainer);
    await runtime.getRelationship("test.Widget", "obj-1", "children", maintainer);
    expect(adapter.relationshipCount).toBe(1);
  });

  it("invalidateObject clears the cache immediately, even within the TTL", async () => {
    const { runtime, adapter } = await setup("cached", 5_000);
    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(1);

    await runtime.invalidateObject("test.Widget", "obj-1");

    await runtime.getObject("test.Widget", "obj-1", maintainer);
    expect(adapter.resolveCount).toBe(2);
  });

  it("invalidateObject also clears cached relationship resolutions for that object", async () => {
    const { runtime, adapter } = await setup("cached", 5_000);
    await runtime.getRelationship("test.Widget", "obj-1", "children", maintainer);
    expect(adapter.relationshipCount).toBe(1);

    await runtime.invalidateObject("test.Widget", "obj-1");

    await runtime.getRelationship("test.Widget", "obj-1", "children", maintainer);
    expect(adapter.relationshipCount).toBe(2);
  });

  it("caches a computed property's resolved value when its own resolutionMode is \"cached\"", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    let computeCount = 0;
    const compute = async (ctx: ComputeContext) => {
      computeCount++;
      return `${String(await ctx.getProperty("name"))}!`;
    };

    await registry.registerType(
      {
        $id: "https://typesys.dev/types/test/Loud/1.0.0",
        title: "Loud",
        type: "object",
        properties: { name: { type: "string" } },
        "x-computed": { shout: { dependsOn: ["name"], binding: "shout", resolutionMode: "cached", cacheTtlMs: 5_000 } },
        "x-policy": { objectPolicy: "public" }
      },
      { name: "test.Loud", version: "1.0.0", computedImplementations: { shout: compute } }
    );
    await registry.registerMapping({
      id: "map-loud",
      typeName: "test.Loud",
      target: "property",
      targetName: "*",
      dataSourceId: "counting-ds",
      operation: "get",
      resolutionMode: "live"
    });

    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const adapter = new CountingAdapter();
    const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { cache: new InMemoryCache() });

    const first = await runtime.getObject("test.Loud", "obj-1", maintainer);
    const second = await runtime.getObject("test.Loud", "obj-1", maintainer);
    expect(first.values.shout).toBe("Widget One!");
    expect(second.values.shout).toBe("Widget One!");
    expect(computeCount).toBe(1); // computed once, served from cache the second time
  });
});
