import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { Semaphore } from "../src/runtime/concurrency.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

const PARENTS = 6;
const CHILDREN_PER_PARENT = 6;
const MAX_CONCURRENCY = 3;

/** Every method is slow and tracked, so the test can see the peak number of adapter calls in flight. */
class InFlightTrackingAdapter implements Adapter {
  readonly dataSourceId = "slow-ds";
  inFlight = 0;
  peak = 0;
  /** Optional: a nested runtime call made from inside resolveProperties (the re-entrancy case). */
  onResolve?: () => Promise<unknown>;

  private async track<T>(fn: () => T | Promise<T>): Promise<T> {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await fn();
    } finally {
      this.inFlight--;
    }
  }

  resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    return this.track(async () => {
      if (this.onResolve) await this.onResolve();
      return { values: { id: objectId }, provenance: [] };
    });
  }

  queryByType(): Promise<AdapterQueryResult> {
    return this.track(() => ({
      items: Array.from({ length: PARENTS }, (_, i) => ({ objectId: `parent-${i}`, values: { id: `parent-${i}` }, provenance: [] }))
    }));
  }

  resolveRelationship(): Promise<RelatedRef[]> {
    return this.track(() => Array.from({ length: CHILDREN_PER_PARENT }, (_, i) => ({ objectId: `child-${i}` })));
  }

  executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return this.track(() => input);
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

async function setup(opts: { computedCallsAdapter?: boolean } = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const childSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Child/1.0.0",
    title: "Child",
    type: "object",
    properties: { id: { type: "string" } },
    // `echo` makes its own adapter call, like a cross-source computed property (ADR-0022).
    ...(opts.computedCallsAdapter ? { "x-computed": { echo: { dependsOn: [], binding: "echo" } } } : {}),
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(childSchema, {
    name: "test.Child",
    version: "1.0.0",
    computedImplementations: {
      echo: async (ctx) => (await ctx.getAdapter("slow-ds").resolveProperties("test.Child", "x", [])).values.id
    }
  });
  const parentSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Parent/1.0.0",
    title: "Parent",
    type: "object",
    properties: { id: { type: "string" } },
    "x-relationships": {
      children: { target: "test.Child", cardinality: "one-to-many", resolution: { dataSourceId: "slow-ds", operation: "byForeignKey:parentId" } }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(parentSchema, { name: "test.Parent", version: "1.0.0" });
  for (const typeName of ["test.Child", "test.Parent"]) {
    await registry.registerMapping({
      id: `map-${typeName}`,
      typeName,
      target: "property",
      targetName: "*",
      dataSourceId: "slow-ds",
      operation: "get",
      resolutionMode: "live"
    });
  }

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const adapter = new InFlightTrackingAdapter();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { maxConcurrency: MAX_CONCURRENCY });
  return { runtime, adapter };
}

describe("One concurrency budget per top-level runtime call", () => {
  it("caps adapter calls across nested fan-out (query page x include x relationship), not per level", async () => {
    const { runtime, adapter } = await setup();
    const result = await runtime.query({ type: "test.Parent", include: [{ relationship: "children" }] }, identity);

    expect(result.items).toHaveLength(PARENTS);
    expect(result.items.every((p) => (p.values.children as unknown[]).length === CHILDREN_PER_PARENT)).toBe(true);
    // Per-level caps would allow MAX_CONCURRENCY (items) x MAX_CONCURRENCY (children) = 9 at once.
    expect(adapter.peak).toBeLessThanOrEqual(MAX_CONCURRENCY);
    expect(adapter.peak).toBeGreaterThan(1); // still genuinely concurrent
  });

  it("counts adapter calls made inside computed properties against the same budget", async () => {
    const { runtime, adapter } = await setup({ computedCallsAdapter: true });
    await runtime.query({ type: "test.Parent", include: [{ relationship: "children" }] }, identity);
    expect(adapter.peak).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });

  it("doesn't deadlock when an adapter call re-enters the runtime", async () => {
    const { runtime, adapter } = await setup();
    let nested = 0;
    // Each resolveProperties holds a permit while calling back into the runtime; if that nested call
    // needed a permit from the same exhausted budget, this would hang.
    adapter.onResolve = async () => {
      if (nested++ < 20) await runtime.getObject("test.Parent", "inner", identity);
    };
    const result = await runtime.getRelationship("test.Parent", "parent-0", "children", identity);
    expect(result).toHaveLength(CHILDREN_PER_PARENT);
  });

  it("gives separate top-level calls separate budgets", async () => {
    const { runtime, adapter } = await setup();
    await Promise.all([
      runtime.getRelationship("test.Parent", "parent-0", "children", identity),
      runtime.getRelationship("test.Parent", "parent-1", "children", identity)
    ]);
    // Two independent requests may each use their full budget at the same time.
    expect(adapter.peak).toBeGreaterThan(MAX_CONCURRENCY);
    expect(adapter.peak).toBeLessThanOrEqual(2 * MAX_CONCURRENCY);
  });
});

describe("Semaphore", () => {
  it("never runs more than its permits at once, and runs every task", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const done = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 2));
          inFlight--;
          return i;
        })
      )
    );
    expect(peak).toBe(2);
    expect(done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("releases its permit when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(sem.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
