import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { InMemoryCache } from "../src/runtime/cache.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { QueryFilter } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/** A base repository adapter — the one every existing Type/domain already uses. */
class FakeRepoAdapter implements Adapter {
  resolveCount = 0;
  constructor(
    readonly dataSourceId: string,
    private readonly records: Record<string, Record<string, unknown>>
  ) {}

  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.resolveCount++;
    const values = this.records[objectId] ?? {};
    return { values: { ...values }, provenance: Object.keys(values).map((f) => ({ propertyPath: f, source: { dataSourceId: this.dataSourceId, system: this.dataSourceId, recordId: objectId, field: f }, retrievedAt: "now", confidence: 1 })) };
  }
  async queryByType(_typeName: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    const items = Object.entries(this.records)
      .filter(([, values]) => !filter || matchesFilter(values, filter))
      .map(([objectId, values]) => ({
        objectId,
        values: { ...values },
        provenance: Object.keys(values).map((f) => ({ propertyPath: f, source: { dataSourceId: this.dataSourceId, system: this.dataSourceId, recordId: objectId, field: f }, retrievedAt: "now", confidence: 1 }))
      }));
    return { items };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(action: ActionDefinition, input: unknown): Promise<unknown> {
    return input ?? action;
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

async function setup(opts: { cached?: boolean } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const resolutionMode = opts.cached ? "cached" : "live";

  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Widget/1.0.0",
    title: "Widget",
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      status: { type: "string" },
      warrantyStatus: { type: "string" }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(schema, { name: "test.Widget", version: "1.0.0" });

  await registry.registerMapping({
    id: "map-widget-base",
    typeName: "test.Widget",
    target: "property",
    targetName: "*",
    dataSourceId: "base-ds",
    operation: "get",
    resolutionMode,
    ...(opts.cached ? { cacheTtlMs: 5_000 } : {})
  });
  await registry.registerMapping({
    id: "map-widget-warranty",
    typeName: "test.Widget",
    target: "property",
    targetName: "warrantyStatus",
    dataSourceId: "warranty-ds",
    operation: "get",
    resolutionMode,
    ...(opts.cached ? { cacheTtlMs: 5_000 } : {})
  });

  // A second Type with only a wildcard mapping — no override — to prove the
  // no-overrides path never touches the override adapter at all.
  const plainSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Plain/1.0.0",
    title: "Plain",
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(plainSchema, { name: "test.Plain", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-plain-base",
    typeName: "test.Plain",
    target: "property",
    targetName: "*",
    dataSourceId: "base-ds",
    operation: "get",
    resolutionMode: "live"
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);

  const baseAdapter = new FakeRepoAdapter("base-ds", {
    "w-1": { id: "w-1", name: "Widget One", status: "active" },
    "w-2": { id: "w-2", name: "Widget Two", status: "retired" },
    "p-1": { id: "p-1", name: "Plain One" }
  });
  const warrantyAdapter = new FakeRepoAdapter("warranty-ds", {
    "w-1": { warrantyStatus: "expired" }
    // "w-2" deliberately has no warranty record.
  });

  const cache = opts.cached ? new InMemoryCache() : undefined;
  const runtime = new SemanticRuntime(registry, [baseAdapter, warrantyAdapter], policyEngine, { cache });

  return { registry, runtime, baseAdapter, warrantyAdapter };
}

describe("Multi-source property composition (ADR-0023)", () => {
  it("getObject merges the base bundle with a per-property override from a different DataSource", async () => {
    const { runtime } = await setup();
    const widget = await runtime.getObject("test.Widget", "w-1", identity, { includeProvenance: true });

    expect(widget.values.name).toBe("Widget One"); // from base-ds
    expect(widget.values.warrantyStatus).toBe("expired"); // from warranty-ds

    const warrantyProvenance = widget.provenance?.find((p) => p.propertyPath === "warrantyStatus");
    expect(warrantyProvenance?.source.dataSourceId).toBe("warranty-ds"); // not base-ds
  });

  it("an object missing from the override system keeps the base's value (or absence) — no error", async () => {
    const { runtime } = await setup();
    const widget = await runtime.getObject("test.Widget", "w-2", identity);
    expect(widget.values.name).toBe("Widget Two");
    expect("warrantyStatus" in widget.values).toBe(false);
  });

  it("query() merges the override into every item on the page", async () => {
    const { runtime } = await setup();
    const result = await runtime.query({ type: "test.Widget" }, identity);
    const byId = new Map(result.items.map((i) => [i.objectId, i.values]));
    expect(byId.get("w-1")?.warrantyStatus).toBe("expired");
    expect("warrantyStatus" in (byId.get("w-2") ?? {})).toBe(false);
  });

  it("a Type with only a wildcard mapping never calls the override adapter — zero cost when unused", async () => {
    const { runtime, warrantyAdapter } = await setup();
    await runtime.getObject("test.Plain", "p-1", identity);
    await runtime.query({ type: "test.Plain" }, identity);
    expect(warrantyAdapter.resolveCount).toBe(0);
  });

  it("invalidateObject clears the cache for the base AND every override", async () => {
    const { runtime, baseAdapter, warrantyAdapter } = await setup({ cached: true });

    await runtime.getObject("test.Widget", "w-1", identity);
    await runtime.getObject("test.Widget", "w-1", identity);
    expect(baseAdapter.resolveCount).toBe(1);
    expect(warrantyAdapter.resolveCount).toBe(1);

    await runtime.invalidateObject("test.Widget", "w-1");
    await runtime.getObject("test.Widget", "w-1", identity);
    expect(baseAdapter.resolveCount).toBe(2);
    expect(warrantyAdapter.resolveCount).toBe(2);
  });

  it("two mappings claiming the same override field fail loudly instead of silently picking one", async () => {
    const { registry, runtime } = await setup();
    await registry.registerMapping({
      id: "map-widget-warranty-duplicate",
      typeName: "test.Widget",
      target: "property",
      targetName: "warrantyStatus",
      dataSourceId: "base-ds",
      operation: "get",
      resolutionMode: "live"
    });

    await expect(runtime.getObject("test.Widget", "w-1", identity)).rejects.toThrow(/more than one property Mapping/);
  });
});
