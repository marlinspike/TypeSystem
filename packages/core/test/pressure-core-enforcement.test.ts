import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter, SortKey } from "../src/model/query.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { Identity } from "../src/model/policy.js";
import type { ComputeContext } from "../src/model/context.js";
import type { ActionDefinition } from "../src/model/action.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Adversarial pressure tests for the core enforcement changes (ADR-0052,
 * 0053, 0054, 0060, 0062). Each test asserts the SECURE behavior; a failure
 * is a confirmed finding.
 */
class RepoAdapter implements Adapter {
  readonly dataSourceId = "ds";
  readonly data = new Map<string, Map<string, Record<string, unknown>>>();
  readonly limits: (number | undefined)[] = [];

  seed(typeName: string, id: string, values: Record<string, unknown>): void {
    if (!this.data.has(typeName)) this.data.set(typeName, new Map());
    this.data.get(typeName)!.set(id, values);
  }
  private prov(id: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: "ds", system: "unit-db", recordId: id, field },
      retrievedAt: "2026-01-01T00:00:00.000Z"
    }));
  }
  async resolveProperties(typeName: string, id: string): Promise<ResolvedProperties> {
    const v = this.data.get(typeName)?.get(id) ?? {};
    return { values: { ...v }, provenance: this.prov(id, v) };
  }
  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, _sort?: SortKey[]): Promise<AdapterQueryResult> {
    this.limits.push(limit);
    const all = [...(this.data.get(typeName) ?? new Map<string, Record<string, unknown>>()).entries()]
      .map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(objectId, values) }))
      .filter((i) => (filter ? matchesFilter(i.values, filter) : true));
    const start = cursor ? Number(cursor) : 0;
    const end = limit !== undefined ? start + limit : all.length;
    return { items: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    return { ok: true };
  }
}

const STATUS: Record<string, string> = { A: "ready", B: "limited", C: "down" };

const officer: Identity = { subjectId: "officer", roles: ["officer", "reader"], attributes: {}, clearance: "SECRET" };
const reader: Identity = { subjectId: "reader", roles: ["reader"], attributes: {}, clearance: "SECRET" };
const uncleared: Identity = { subjectId: "uncleared", roles: ["reader"], attributes: {}, clearance: "UNCLASSIFIED" };

const impls = {
  status: async (ctx: ComputeContext) => STATUS[String(await ctx.getProperty("code"))] ?? "unknown",
  // Declares no input at all, yet reads the officers-only `code`.
  sneaky: async (ctx: ComputeContext) => `code=${String(await ctx.getProperty("code"))}`,
  // Releases `status` (an innocuous-looking computed input) - which is a bijection of the officers-only `code`.
  statusEcho: async (ctx: ComputeContext) => `echo:${String(await ctx.getProperty("status"))}`,
  // A value schema the binding can violate, but only for some hidden codes.
  strictStatus: async (ctx: ComputeContext) => STATUS[String(await ctx.getProperty("code"))] ?? "unknown"
};

async function setup(extra: { computed?: SemanticTypeSchema["x-computed"]; runtimeOpts?: ConstructorParameters<typeof SemanticRuntime>[3] } = {}) {
  const store = new InMemoryRegistryStore();
  const registry = new SemanticRegistry(store);
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/p/Unit/1.0.0",
      title: "Unit",
      type: "object",
      properties: { name: { type: "string" }, code: { type: "string" }, rating: { type: "number" } },
      "x-computed": { status: { dependsOn: ["code"], binding: "status" }, ...(extra.computed ?? {}) },
      "x-policy": { objectPolicy: "readers", propertyPolicies: { code: "officers" } }
    },
    { name: "p.Unit", version: "1.0.0", computedImplementations: impls }
  );
  await registry.registerMapping({ id: "map-unit", typeName: "p.Unit", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  const policy = new AbacPolicyEngine();
  policy.registerRule("readers", requireRole("reader"));
  policy.registerRule("officers", requireRole("officer"));
  policy.registerRule("anyone", allowAllRule);
  const adapter = new RepoAdapter();
  adapter.seed("p.Unit", "u1", { name: "Alpha", code: "A", rating: 9 });
  adapter.seed("p.Unit", "u2", { name: "Bravo", code: "C", rating: 2 });
  adapter.seed("p.Unit", "u3", { name: "Charlie", code: "B", rating: 5 });
  const runtime = new SemanticRuntime(registry, [adapter], policy, { classification: DEMO_LINEAR_CLASSIFICATION, ...(extra.runtimeOpts ?? {}) });
  return { runtime, registry, store, adapter, policy };
}

describe("ADR-0052 pressure: derivation gate", () => {
  it("[FINDING] a computed property cannot read an input it did not declare in dependsOn", async () => {
    const { runtime } = await setup({ computed: { sneaky: { dependsOn: [], binding: "sneaky" } } });
    // Officer-only `code` must not reach a reader through an undeclared read.
    let value: unknown;
    try {
      value = (await runtime.getObject("p.Unit", "u1", reader)).values.sneaky;
    } catch {
      value = undefined; // refusing the read is also acceptable
    }
    expect(value).not.toBe("code=A");
  });

  it("[FINDING] releasing a computed input does not silently release that input's own protected inputs", async () => {
    // statusEcho releases only `status`; `status` is withheld solely because it derives from officers-only `code`.
    const { runtime } = await setup({ computed: { statusEcho: { dependsOn: ["status"], binding: "statusEcho", releases: ["status"] } } });
    const asReader = (await runtime.getObject("p.Unit", "u1", reader)).values;
    expect(asReader).not.toHaveProperty("status");
    // Expected: the bijection of `code` stays withheld unless `code` itself is released somewhere along the chain.
    expect(asReader.statusEcho).not.toBe("echo:ready");
  });

  it("[FINDING] a computed value's schema check does not turn a withheld input into a per-object error oracle", async () => {
    const { runtime } = await setup({
      computed: { strictStatus: { dependsOn: ["code"], binding: "strictStatus", schema: { type: "string", enum: ["ready", "limited"] } } }
    });
    // The reader can't read `code`, `status` or `strictStatus`. Whether their read of an object succeeds must
    // not depend on the hidden `code` (u2 has code C -> "down", outside the enum).
    const outcome = async (id: string) => runtime.getObject("p.Unit", id, reader).then(() => "ok", (e: Error) => e.constructor.name);
    expect(await outcome("u1")).toBe(await outcome("u2"));
  });
});

describe("ADR-0054 pressure: filters on computed values", () => {
  it("[HOLDS] filtering on a computed value derived from a hidden input reveals nothing to the reader", async () => {
    const { runtime } = await setup();
    const eq = await runtime.query({ type: "p.Unit", filter: { property: "status", operator: "eq", value: "ready" } }, reader);
    expect(eq.items).toEqual([]);
    const ne = await runtime.query({ type: "p.Unit", filter: { property: "status", operator: "ne", value: "ready" } }, reader);
    expect(ne.items.map((i) => i.objectId).sort()).toEqual(["u1", "u2", "u3"]);
    const or = await runtime.query({ type: "p.Unit", filter: { or: [{ property: "status", operator: "eq", value: "down" }, { property: "name", operator: "eq", value: "Alpha" }] } }, reader);
    expect(or.items.map((i) => i.objectId)).toEqual(["u1"]);
    // An officer still filters on it.
    const asOfficer = await runtime.query({ type: "p.Unit", filter: { property: "status", operator: "eq", value: "down" } }, officer);
    expect(asOfficer.items.map((i) => i.objectId)).toEqual(["u2"]);
  });

  it("[HOLDS] sorting on a computed property is still refused", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "p.Unit", sort: [{ property: "status" }] }, officer)).rejects.toThrow();
  });

  it("[FINDING] a forged scan cursor cannot make one query ask the adapter for more rows than maxScanned / maxLimit", async () => {
    const { runtime, adapter } = await setup();
    const forged = "ts1." + Buffer.from(JSON.stringify({ skip: 50_000_000 }), "utf8").toString("base64url");
    adapter.limits.length = 0;
    await runtime.query({ type: "p.Unit", filter: { property: "status", operator: "eq", value: "ready" }, limit: 1, cursor: forged }, officer).catch(() => undefined);
    const asked = Math.max(...adapter.limits.map((l) => l ?? Infinity));
    expect(asked).toBeLessThanOrEqual(1000);
  });

  it("[FINDING] explainQuery refuses a caller not cleared for a marked Type, as query does", async () => {
    const store = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(store);
    await registry.registerType(
      {
        $id: "https://typesys.dev/types/p/Secret/1.0.0",
        title: "Secret",
        type: "object",
        properties: { name: { type: "string" }, code: { type: "string" } },
        "x-computed": { status: { dependsOn: ["code"], binding: "status" } },
        "x-policy": { objectPolicy: "readers", propertyPolicies: { code: "officers" } },
        "x-provenance": { defaultClassification: "SECRET" }
      },
      { name: "p.Secret", version: "1.0.0", computedImplementations: impls }
    );
    await registry.registerMapping({ id: "m", typeName: "p.Secret", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    const policy = new AbacPolicyEngine();
    policy.registerRule("readers", requireRole("reader"));
    policy.registerRule("officers", requireRole("officer"));
    const runtime = new SemanticRuntime(registry, [new RepoAdapter()], policy, { classification: DEMO_LINEAR_CLASSIFICATION });
    await expect(runtime.query({ type: "p.Secret" }, uncleared)).rejects.toBeInstanceOf(AuthorizationError);
    // The plan names computed properties, their inputs, member policies and sources of a Type the caller can't see.
    await expect(runtime.explainQuery({ type: "p.Secret" }, uncleared)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("ADR-0053 pressure: instance-scoped Action preconditions", () => {
  it("[FINDING] previewAction does not disclose a member-policy-hidden attribute through a precondition outcome", async () => {
    const { runtime, registry } = await setup();
    const Ground: ActionDefinition = {
      id: "a-ground",
      name: "GroundUnit",
      description: "Ground a unit.",
      applicableTypes: ["p.Unit"],
      target: { idFrom: "unitId" },
      inputSchema: { type: "object", properties: { unitId: { type: "string" } }, required: ["unitId"], additionalProperties: false },
      outputSchema: { type: "object" },
      authorizationPolicy: "readers",
      preconditions: [{ description: "The unit is ready", check: async (ctx) => (await ctx.getProperty("code")) === "A" }],
      implementation: { dataSourceId: "ds", operation: "ground" },
      sideEffects: "mutates",
      idempotency: "natural",
      auditRequired: true,
      version: "1.0.0"
    };
    await registry.registerAction(Ground);
    const p1 = await runtime.previewAction("GroundUnit", { unitId: "u1" }, reader);
    const p2 = await runtime.previewAction("GroundUnit", { unitId: "u2" }, reader);
    // The reader may not read `code`; the preview outcome must not differ by its value.
    expect(p1.preconditions[0]!.satisfied).toBe(p2.preconditions[0]!.satisfied);
  });
});

describe("ADR-0060 pressure: subtypes", () => {
  const base = (policies: Record<string, string>): SemanticTypeSchema => ({
    $id: "https://typesys.dev/types/p/Base/1.0.0",
    title: "Base",
    type: "object",
    properties: { name: { type: "string" }, code: { type: "string" }, rating: { type: "number" } },
    "x-policy": { objectPolicy: "readers", propertyPolicies: policies },
    "x-provenance": { properties: { rating: { classification: "SECRET" } } }
  });

  it("[HOLDS] a grand-child cannot replace a property policy or marking its grandparent set", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await registry.registerType(base({ code: "officers" }), { name: "p.Base", version: "1.0.0" });
    await registry.registerType({ $id: "https://typesys.dev/types/p/Mid/1.0.0", title: "Mid", type: "object" }, { name: "p.Mid", version: "1.0.0", extends: "p.Base" });
    await expect(
      registry.registerType(
        { $id: "https://typesys.dev/types/p/Leaf/1.0.0", title: "Leaf", type: "object", "x-policy": { objectPolicy: "anyone", propertyPolicies: { code: "anyone" } } },
        { name: "p.Leaf", version: "1.0.0", extends: "p.Mid" }
      )
    ).rejects.toThrow();
    await expect(
      registry.registerType(
        { $id: "https://typesys.dev/types/p/Leaf2/1.0.0", title: "Leaf2", type: "object", "x-provenance": { properties: { rating: { classification: "UNCLASSIFIED" } } } },
        { name: "p.Leaf2", version: "1.0.0", extends: "p.Mid" }
      )
    ).rejects.toThrow();
    const leaf = await registry.registerType({ $id: "https://typesys.dev/types/p/Leaf3/1.0.0", title: "Leaf3", type: "object" }, { name: "p.Leaf3", version: "1.0.0", extends: "p.Mid" });
    expect(leaf.schema["x-policy"]?.propertyPolicies?.code).toBe("officers");
    expect(leaf.schema["x-provenance"]?.properties?.rating?.classification).toBe("SECRET");
  });

  it("[FINDING] a subtype's computed property cannot read a base-protected value without declaring it", async () => {
    const store = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(store);
    await registry.registerType(base({ code: "officers" }), { name: "p.Base", version: "1.0.0" });
    await registry.registerType(
      { $id: "https://typesys.dev/types/p/Sub/1.0.0", title: "Sub", type: "object", "x-computed": { sneaky: { dependsOn: [], binding: "sneaky" } } },
      { name: "p.Sub", version: "1.0.0", extends: "p.Base", computedImplementations: impls }
    );
    await registry.registerMapping({ id: "m", typeName: "p.Sub", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
    const policy = new AbacPolicyEngine();
    policy.registerRule("readers", requireRole("reader"));
    policy.registerRule("officers", requireRole("officer"));
    const adapter = new RepoAdapter();
    adapter.seed("p.Sub", "s1", { name: "S", code: "A" });
    const runtime = new SemanticRuntime(registry, [adapter], policy, { classification: DEMO_LINEAR_CLASSIFICATION });
    const v = (await runtime.getObject("p.Sub", "s1", reader)).values;
    expect(v).not.toHaveProperty("code");
    expect(v.sneaky).not.toBe("code=A");
  });

  it("[FINDING] a subtype keeps protections its base gains in a later version", async () => {
    const store = new InMemoryRegistryStore();
    const registry = new SemanticRegistry(store);
    await registry.registerType(base({}), { name: "p.Base", version: "1.0.0" });
    await registry.registerType({ $id: "https://typesys.dev/types/p/Sub/1.0.0", title: "Sub", type: "object" }, { name: "p.Sub", version: "1.0.0", extends: "p.Base" });
    await registry.registerType({ ...base({ code: "officers" }), $id: "https://typesys.dev/types/p/Base/2.0.0" }, { name: "p.Base", version: "2.0.0" });
    const baseNow = await registry.getType("p.Base");
    expect(baseNow?.schema["x-policy"]?.propertyPolicies?.code).toBe("officers");
    const sub = await registry.getType("p.Sub");
    // Either the subtype must pick up the tightened base policy, or the base upgrade must be refused / flagged.
    expect(sub?.schema["x-policy"]?.propertyPolicies?.code).toBe("officers");
  });
});
