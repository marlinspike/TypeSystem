import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../src/runtime/rate-limiter.js";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import type { Adapter } from "../src/runtime/adapter.js";

const adapter: Adapter = {
  dataSourceId: "mem",
  resolveProperties: async () => ({ values: { id: "w1" }, provenance: [] }),
  queryByType: async () => ({ items: [] }),
  resolveRelationship: async () => [],
  executeAction: async () => ({})
};

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    { $id: "https://typesys.dev/types/test/Widget/1.0.0", title: "Widget", type: "object", properties: { id: { type: "string" } }, "x-policy": { objectPolicy: "public" } },
    { name: "test.Widget", version: "1.0.0" }
  );
  await registry.registerMapping({ id: "m", typeName: "test.Widget", target: "property", targetName: "*", dataSourceId: "mem", operation: "get", resolutionMode: "live" });
  const engine = new AbacPolicyEngine();
  engine.registerRule("public", allowAllRule);
  const runtime = new SemanticRuntime(registry, [adapter], engine, { rateLimiter: new InMemoryRateLimiter({ capacity: 1, refillPerSecond: 0 }) });
  return { runtime, registry };
}

describe("P8 SemanticRuntime.explaining()", () => {
  it("P8-L5: an explanation is charged to its investigator for every 100 operations it replays, and runs no Action", async () => {
    const { runtime } = await setup();
    const subject = { subjectId: "bulk-reader", roles: [], attributes: {} };
    const investigator = { subjectId: "anyone", roles: [], attributes: {} };
    let reads = 0;
    // Capacity 1, no refill: the start takes the one token, so the 100th replayed operation is refused.
    const err = await runtime
      .explaining(investigator, async () => {
        for (let i = 0; i < 250; i++) {
          await runtime.getObject("test.Widget", "w1", subject);
          reads++;
        }
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"anyone"');
    expect(reads).toBe(99);
    const { runtime: fresh } = await setup();
    await expect(fresh.explaining(investigator, () => fresh.invokeAction("test.Anything", {}, subject))).rejects.toThrow(/inside an explanation/);
  });
});
