import { describe, it, expect } from "vitest";
import { InMemoryRateLimiter, NoopRateLimiter } from "../src/runtime/rate-limiter.js";
import { RateLimitExceededError } from "../src/runtime/errors.js";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

class FakeAdapter implements Adapter {
  constructor(readonly dataSourceId: string) {}
  async resolveProperties(): Promise<ResolvedProperties> {
    return { values: { id: "w1" }, provenance: [] };
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: [] };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    return input;
  }
}

describe("NoopRateLimiter", () => {
  it("always allows", () => {
    const limiter = new NoopRateLimiter();
    for (let i = 0; i < 1000; i++) expect(limiter.tryAcquire("any-key")).toBe(true);
  });
});

describe("InMemoryRateLimiter (token bucket)", () => {
  it("allows up to `capacity` calls, then rejects", () => {
    const limiter = new InMemoryRateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(false);
  });

  it("refills over time", async () => {
    const limiter = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 20 }); // one token every 50ms
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(limiter.tryAcquire("k")).toBe(true);
  });

  it("tracks each key's budget independently", () => {
    const limiter = new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(limiter.tryAcquire("alice")).toBe(true);
    expect(limiter.tryAcquire("alice")).toBe(false);
    expect(limiter.tryAcquire("bob")).toBe(true); // unaffected by alice's exhausted budget
  });

  it("never exceeds capacity even after a long idle period", async () => {
    const limiter = new InMemoryRateLimiter({ capacity: 2, refillPerSecond: 1000 });
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Would have refilled far more than capacity if not clamped.
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(true);
    expect(limiter.tryAcquire("k")).toBe(false);
  });
});

const identity: Identity = { subjectId: "rate-limited-user", roles: [], attributes: {} };

async function setup(rateLimiter: InMemoryRateLimiter) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Widget/1.0.0",
    title: "Widget",
    type: "object",
    properties: { id: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(schema, { name: "test.Widget", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-widget",
    typeName: "test.Widget",
    target: "property",
    targetName: "*",
    dataSourceId: "mem",
    operation: "get",
    resolutionMode: "live"
  });

  const adapter = new FakeAdapter("mem");

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);

  // Cache/defaultCacheTtlMs left at their defaults (NoopCache) — only the 6th
  // constructor argument (rateLimiter) is under test here.
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, undefined, undefined, rateLimiter);
  return runtime;
}

describe("SemanticRuntime + RateLimiter integration", () => {
  it("throws RateLimitExceededError once the per-identity budget is exhausted", async () => {
    const runtime = await setup(new InMemoryRateLimiter({ capacity: 2, refillPerSecond: 0 }));

    await expect(runtime.getObject("test.Widget", "w1", identity)).resolves.toBeDefined();
    await expect(runtime.getObject("test.Widget", "w1", identity)).resolves.toBeDefined();
    await expect(runtime.getObject("test.Widget", "w1", identity)).rejects.toThrow(RateLimitExceededError);
  });

  it("rate-limits by identity.subjectId, not globally", async () => {
    const runtime = await setup(new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 0 }));
    const other: Identity = { subjectId: "another-user", roles: [], attributes: {} };

    await expect(runtime.getObject("test.Widget", "w1", identity)).resolves.toBeDefined();
    await expect(runtime.getObject("test.Widget", "w1", identity)).rejects.toThrow(RateLimitExceededError);
    // A different identity has its own, untouched budget.
    await expect(runtime.getObject("test.Widget", "w1", other)).resolves.toBeDefined();
  });

  it("with no rateLimiter supplied, behaves exactly as before ADR-0019 (unlimited)", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Widget2/1.0.0",
      title: "Widget2",
      type: "object",
      properties: { id: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(schema, { name: "test.Widget2", version: "1.0.0" });
    await registry.registerMapping({
      id: "map-widget2",
      typeName: "test.Widget2",
      target: "property",
      targetName: "*",
      dataSourceId: "mem2",
      operation: "get",
      resolutionMode: "live"
    });
    const adapter = new FakeAdapter("mem2");
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const runtime = new SemanticRuntime(registry, [adapter], policyEngine);

    for (let i = 0; i < 50; i++) {
      await expect(runtime.getObject("test.Widget2", "w1", identity)).resolves.toBeDefined();
    }
  });
});
