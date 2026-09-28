import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

const DELAY_MS = 25;
const CHILD_COUNT = 8;

/** An adapter that tracks how many resolveProperties calls were in flight at once, to prove fan-out is concurrent, not sequential. */
class SlowConcurrencyTrackingAdapter implements Adapter {
  readonly dataSourceId = "slow-ds";
  inFlight = 0;
  maxConcurrent = 0;
  resolveCalls = 0;

  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.resolveCalls++;
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    this.inFlight--;
    return { values: { id: objectId, label: `child-${objectId}` }, provenance: [] };
  }

  async queryByType(): Promise<AdapterQueryResult> {
    const items = Array.from({ length: CHILD_COUNT }, (_, i) => ({ objectId: `parent-${i}`, values: { id: `parent-${i}` }, provenance: [] }));
    return { items };
  }

  async resolveRelationship(): Promise<RelatedRef[]> {
    return Array.from({ length: CHILD_COUNT }, (_, i) => ({ objectId: `child-${i}` }));
  }

  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return input;
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const childSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Child/1.0.0",
    title: "Child",
    type: "object",
    properties: { id: { type: "string" }, label: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(childSchema, { name: "test.Child", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-child",
    typeName: "test.Child",
    target: "property",
    targetName: "*",
    dataSourceId: "slow-ds",
    operation: "get",
    resolutionMode: "live"
  });

  const parentSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Parent/1.0.0",
    title: "Parent",
    type: "object",
    properties: { id: { type: "string" } },
    "x-relationships": {
      children: {
        target: "test.Child",
        cardinality: "one-to-many",
        resolution: { dataSourceId: "slow-ds", operation: "byForeignKey:parentId" }
      }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(parentSchema, { name: "test.Parent", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-parent",
    typeName: "test.Parent",
    target: "property",
    targetName: "*",
    dataSourceId: "slow-ds",
    operation: "get",
    resolutionMode: "live"
  });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const adapter = new SlowConcurrencyTrackingAdapter();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine);

  return { runtime, adapter };
}

describe("N+1 relationship/query fan-out is concurrent, not sequential", () => {
  it("getRelationship resolves all related objects concurrently", async () => {
    const { runtime, adapter } = await setup();

    const start = Date.now();
    const children = await runtime.getRelationship("test.Parent", "parent-0", "children", identity);
    const elapsedMs = Date.now() - start;

    expect(children).toHaveLength(CHILD_COUNT);
    expect(adapter.resolveCalls).toBe(CHILD_COUNT);
    expect(adapter.maxConcurrent).toBeGreaterThan(1); // proves overlap, not one-at-a-time
    // Sequential would take >= CHILD_COUNT * DELAY_MS; concurrent should be close to one DELAY_MS.
    expect(elapsedMs).toBeLessThan(CHILD_COUNT * DELAY_MS);
  });

  it("query with include resolves every item's relationships concurrently across the whole page", async () => {
    const { runtime, adapter } = await setup();

    const start = Date.now();
    const result = await runtime.query({ type: "test.Parent", include: [{ relationship: "children" }] }, identity);
    const elapsedMs = Date.now() - start;

    expect(result.items).toHaveLength(CHILD_COUNT); // CHILD_COUNT parents returned by queryByType
    for (const item of result.items) {
      expect((item.values.children as unknown[]).length).toBe(CHILD_COUNT);
    }
    // CHILD_COUNT parents x CHILD_COUNT children each = CHILD_COUNT^2 total resolves, all fanned out concurrently.
    expect(adapter.resolveCalls).toBe(CHILD_COUNT * CHILD_COUNT);
    expect(adapter.maxConcurrent).toBeGreaterThan(CHILD_COUNT); // more overlap than a single item's own fan-out
    expect(elapsedMs).toBeLessThan(CHILD_COUNT * CHILD_COUNT * DELAY_MS);
  });
});
