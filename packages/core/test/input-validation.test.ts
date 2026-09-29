import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { AbacPolicyEngine, allowAllRule } from "../src/policy/abac-policy-engine.js";
import { InvalidInputError } from "../src/runtime/errors.js";
import { InputValidator, DEFAULT_QUERY_LIMITS } from "../src/runtime/input-validation.js";
import type { Adapter, ResolvedProperties, RelatedRef, AdapterQueryResult } from "../src/runtime/adapter.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { Identity } from "../src/model/policy.js";
import type { QueryFilter, SemanticQuery } from "../src/model/query.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/** Records what the runtime actually asked it for, so tests can assert on the limit that reached the adapter. */
class RecordingAdapter implements Adapter {
  readonly dataSourceId = "rec-ds";
  queryCalls = 0;
  lastLimit: number | undefined;
  actionCalls = 0;

  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    return { values: { id: objectId }, provenance: [] };
  }

  async queryByType(_typeName: string, _filter?: QueryFilter, limit?: number): Promise<AdapterQueryResult> {
    this.queryCalls++;
    this.lastLimit = limit;
    return { items: [] };
  }

  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }

  async executeAction(_action: ActionDefinition, input: unknown): Promise<unknown> {
    this.actionCalls++;
    return input;
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} };

const DoThingAction: ActionDefinition = {
  id: "action-do-thing",
  name: "DoThing",
  description: "test",
  applicableTypes: ["test.Thing"],
  inputSchema: {
    type: "object",
    properties: { count: { type: "integer", minimum: 0 } },
    required: ["count"],
    additionalProperties: false
  },
  outputSchema: { type: "object" },
  authorizationPolicy: "public",
  implementation: { dataSourceId: "rec-ds", operation: "doThing" },
  sideEffects: "none",
  idempotency: "natural",
  auditRequired: false,
  version: "1.0.0"
};

async function setup(queryLimits = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Thing/1.0.0",
    title: "Thing",
    type: "object",
    properties: { id: { type: "string" } },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(schema, { name: "test.Thing", version: "1.0.0" });
  await registry.registerMapping({
    id: "map-thing",
    typeName: "test.Thing",
    target: "property",
    targetName: "*",
    dataSourceId: "rec-ds",
    operation: "get",
    resolutionMode: "live"
  });
  await registry.registerAction(DoThingAction);

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  const adapter = new RecordingAdapter();
  const runtime = new SemanticRuntime(registry, [adapter], policyEngine, { queryLimits });
  return { runtime, adapter };
}

function nestedFilter(depth: number): QueryFilter {
  let filter: QueryFilter = { property: "id", operator: "eq", value: "x" };
  for (let i = 1; i < depth; i++) filter = { and: [filter] };
  return filter;
}

describe("Query validation and limits", () => {
  it("applies defaultLimit when a query omits limit — adapters would otherwise return everything", async () => {
    const { runtime, adapter } = await setup();
    await runtime.query({ type: "test.Thing" }, identity);
    expect(adapter.lastLimit).toBe(DEFAULT_QUERY_LIMITS.defaultLimit);
  });

  it("passes an in-bounds limit through unchanged", async () => {
    const { runtime, adapter } = await setup();
    await runtime.query({ type: "test.Thing", limit: 5 }, identity);
    expect(adapter.lastLimit).toBe(5);
  });

  it("rejects (not clamps) a limit above maxLimit, before any adapter call", async () => {
    const { runtime, adapter } = await setup({ maxLimit: 50, defaultLimit: 10 });
    await expect(runtime.query({ type: "test.Thing", limit: 51 }, identity)).rejects.toBeInstanceOf(InvalidInputError);
    expect(adapter.queryCalls).toBe(0);
  });

  it.each([
    ["missing type", {}],
    ["non-integer limit", { type: "test.Thing", limit: 2.5 }],
    ["zero limit", { type: "test.Thing", limit: 0 }],
    ["unknown top-level field", { type: "test.Thing", orderBy: "id" }],
    ["unknown operator", { type: "test.Thing", filter: { property: "id", operator: "regex", value: ".*" } }],
    ["condition missing value", { type: "test.Thing", filter: { property: "id", operator: "eq" } }],
    ["empty and", { type: "test.Thing", filter: { and: [] } }],
    ["include without relationship", { type: "test.Thing", include: [{}] }],
    ["not an object", "test.Thing"],
    ["null", null]
  ])("rejects a malformed query: %s", async (_label, input) => {
    const { runtime, adapter } = await setup();
    await expect(runtime.query(input as unknown as SemanticQuery, identity)).rejects.toBeInstanceOf(InvalidInputError);
    expect(adapter.queryCalls).toBe(0);
  });

  it("rejects too many includes", async () => {
    const { runtime } = await setup({ maxIncludes: 2 });
    const include = [{ relationship: "a" }, { relationship: "b" }, { relationship: "c" }];
    await expect(runtime.query({ type: "test.Thing", include }, identity)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("enforces maxFilterDepth, allowing exactly the limit", async () => {
    const { runtime } = await setup({ maxFilterDepth: 3 });
    await expect(runtime.query({ type: "test.Thing", filter: nestedFilter(3) }, identity)).resolves.toBeDefined();
    await expect(runtime.query({ type: "test.Thing", filter: nestedFilter(4) }, identity)).rejects.toThrow(/nesting depth 4/);
  });

  it("enforces maxFilterConditions across the whole tree", async () => {
    const { runtime } = await setup({ maxFilterConditions: 3 });
    const cond = { property: "id", operator: "eq" as const, value: "x" };
    await expect(
      runtime.query({ type: "test.Thing", filter: { or: [cond, { and: [cond, cond, cond] }] } }, identity)
    ).rejects.toThrow(/4 conditions/);
  });

  it("rejects pathologically deep JSON cleanly instead of overflowing the stack", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "test.Thing", filter: nestedFilter(50_000) }, identity)).rejects.toThrow(/levels deep/);
  });

  it("refuses to construct with defaultLimit > maxLimit", () => {
    expect(() => new InputValidator({ defaultLimit: 500, maxLimit: 100 })).toThrow(/exceeds maxLimit/);
  });
});

describe("Action input validation", () => {
  it("accepts input matching the Action's inputSchema", async () => {
    const { runtime, adapter } = await setup();
    await expect(runtime.invokeAction("DoThing", { count: 3 }, identity)).resolves.toEqual({ count: 3 });
    expect(adapter.actionCalls).toBe(1);
  });

  it.each([
    ["missing required field", {}],
    ["wrong type", { count: "three" }],
    ["violates minimum", { count: -1 }],
    ["additional property", { count: 1, extra: true }],
    ["not an object", 42]
  ])("rejects invalid input without dispatching to the adapter: %s", async (_label, input) => {
    const { runtime, adapter } = await setup();
    await expect(runtime.invokeAction("DoThing", input, identity)).rejects.toBeInstanceOf(InvalidInputError);
    expect(adapter.actionCalls).toBe(0);
  });
});

describe("Action input validation after re-registration", () => {
  it("validates against the new inputSchema when the same version is re-registered with a changed schema", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerAction(DoThingAction);
    const policyEngine = new AbacPolicyEngine();
    policyEngine.registerRule("public", allowAllRule);
    const runtime = new SemanticRuntime(registry, [new RecordingAdapter()], policyEngine);

    await expect(runtime.invokeAction("DoThing", { count: 1 }, identity)).resolves.toBeDefined();

    // Same name and version, schema changed (e.g. by another instance sharing a durable store).
    await registry.registerAction({
      ...DoThingAction,
      inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false }
    });
    await expect(runtime.invokeAction("DoThing", { count: 1 }, identity)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(runtime.invokeAction("DoThing", { label: "x" }, identity)).resolves.toBeDefined();
  });
});
