import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "redis";
import {
  SemanticRegistry,
  InMemoryRegistryStore,
  SemanticRuntime,
  AbacPolicyEngine,
  allowAllRule,
  RateLimitExceededError,
  type Adapter,
  type AdapterQueryResult,
  type ActionDefinition,
  type Identity,
  type RelatedRef,
  type ResolvedProperties,
  type SemanticTypeSchema
} from "@typesys/core";
import { RedisCache, RedisRateLimiter } from "../src/index.js";

const REDIS_URL = process.env.REDIS_URL;

/** Stands in for the one real backend that every replica talks to. */
const backend: Record<string, Record<string, unknown>> = { w1: { id: "w1", name: "original" } };

/** Each "instance" gets its own adapter object over the shared backend, counting its own reads. */
class SharedBackendAdapter implements Adapter {
  readonly dataSourceId = "shared-ds";
  reads = 0;
  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    this.reads++;
    return { values: { ...(backend[objectId] ?? {}) }, provenance: [] };
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

const identity: Identity = { subjectId: "multi-instance-user", roles: [], attributes: {} };

describe.skipIf(!REDIS_URL)("Two runtime instances sharing Redis (ADR-0025)", () => {
  const client = createClient({ url: REDIS_URL });
  const run = `typesys-test:${Date.now()}:${Math.random().toString(36).slice(2)}:`;

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await new RedisCache(client, { keyPrefix: run }).clear();
    await client.close();
  });

  /** A fully separate runtime — own registry, own adapter, own process-local state — like a second replica. */
  async function instance(shared: { cache?: RedisCache; rateLimiter?: RedisRateLimiter }) {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    const schema: SemanticTypeSchema = {
      $id: "https://typesys.dev/types/test/Widget/1.0.0",
      title: "Widget",
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
      "x-policy": { objectPolicy: "public" }
    };
    await registry.registerType(schema, { name: "test.Widget", version: "1.0.0" });
    await registry.registerMapping({
      id: "map-widget",
      typeName: "test.Widget",
      target: "property",
      targetName: "*",
      dataSourceId: "shared-ds",
      operation: "get",
      resolutionMode: "cached",
      cacheTtlMs: 60_000
    });
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const adapter = new SharedBackendAdapter();
    const runtime = new SemanticRuntime(registry, [adapter], policyEngine, shared);
    return { runtime, adapter };
  }

  it("enforces one rate-limit budget per identity across instances", async () => {
    const rateLimiter = new RedisRateLimiter(client, { capacity: 3, refillPerSecond: 0, keyPrefix: `${run}rl:` });
    const a = await instance({ rateLimiter });
    const b = await instance({ rateLimiter });

    await a.runtime.getObject("test.Widget", "w1", identity);
    await b.runtime.getObject("test.Widget", "w1", identity);
    await a.runtime.getObject("test.Widget", "w1", identity);
    // Per-process limiters would each still have budget left; the shared one is spent.
    await expect(b.runtime.getObject("test.Widget", "w1", identity)).rejects.toBeInstanceOf(RateLimitExceededError);
    await expect(a.runtime.getObject("test.Widget", "w1", identity)).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("serves one instance's cache fill to another, and one instance's invalidation to all", async () => {
    const cache = new RedisCache(client, { keyPrefix: `${run}cache:` });
    const a = await instance({ cache });
    const b = await instance({ cache });

    expect((await a.runtime.getObject("test.Widget", "w1", identity)).values.name).toBe("original");
    expect(a.adapter.reads).toBe(1);

    backend.w1 = { id: "w1", name: "updated" };

    // B never read the backend: it got A's cached copy (stale, by design, until invalidated).
    expect((await b.runtime.getObject("test.Widget", "w1", identity)).values.name).toBe("original");
    expect(b.adapter.reads).toBe(0);

    // A learns of the write and invalidates; B sees fresh data on its next read.
    await a.runtime.invalidateObject("test.Widget", "w1");
    expect((await b.runtime.getObject("test.Widget", "w1", identity)).values.name).toBe("updated");
    expect(b.adapter.reads).toBe(1);
  });
});
