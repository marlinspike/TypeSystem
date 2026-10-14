import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import { DEMO_LINEAR_CLASSIFICATION } from "../src/runtime/classification.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { Identity } from "../src/model/policy.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { ComputeContext } from "../src/model/context.js";

/**
 * ADR-0052: a computed value is readable only by a caller who may read every
 * input it derives from, unless the Type releases that input explicitly — and
 * every release is audited. Before it, `test.Unit.status` (a one-to-one map of
 * the officers-only `code`) went to anyone who could read the Unit.
 */
class RepoAdapter implements Adapter {
  readonly dataSourceId = "ds";
  private readonly data = new Map<string, Map<string, Record<string, unknown>>>();

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
  async queryByType(typeName: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    const items = [...(this.data.get(typeName) ?? new Map<string, Record<string, unknown>>()).entries()].map(([objectId, values]) => ({
      objectId,
      values: { ...values },
      provenance: this.prov(objectId, values)
    }));
    return { items: filter ? items.filter((i) => matchesFilter(i.values, filter)) : items };
  }
  async resolveRelationship(rel: RelationshipDefinition, objectId: string): Promise<RelatedRef[]> {
    if (rel.name !== "units") return [];
    return [...(this.data.get("test.Unit")?.entries() ?? [])].filter(([, v]) => v.baseId === objectId).map(([id]) => ({ objectId: id }));
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const STATUS: Record<string, string> = { A: "ready", B: "limited", C: "down" };

const officer: Identity = { subjectId: "officer", roles: ["officer", "reader"], attributes: {}, clearance: "SECRET" };
const reader: Identity = { subjectId: "reader", roles: ["reader"], attributes: {}, clearance: "SECRET" };
const uncleared: Identity = { subjectId: "uncleared", roles: ["officer", "reader"], attributes: {}, clearance: "UNCLASSIFIED" };

async function setup() {
  const store = new InMemoryRegistryStore();
  const registry = new SemanticRegistry(store);
  const computedImplementations = {
    status: async (ctx: ComputeContext) => STATUS[String(await ctx.getProperty("code"))] ?? "unknown",
    statusLabel: async (ctx: ComputeContext) => `Status: ${String(await ctx.getProperty("status"))}`,
    // Lossy by construction: whether the Unit has any code at all. The Type releases `code` for it.
    hasCode: async (ctx: ComputeContext) => (await ctx.getProperty("code")) !== undefined,
    // Releases `code` but not `rating`: still withheld from whoever can't read `rating`.
    summary: async (ctx: ComputeContext) => `${(await ctx.getProperty("code")) !== undefined}/${String(await ctx.getProperty("rating"))}`,
    // Releases `location`, which is marked SECRET: a marking is never released.
    nearBase: async (ctx: ComputeContext) => String(await ctx.getProperty("location")).startsWith("Base")
  };
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Unit/1.0.0",
      title: "Unit",
      type: "object",
      properties: {
        name: { type: "string" },
        baseId: { type: "string" },
        code: { type: "string" },
        rating: { type: "number" },
        location: { type: "string" }
      },
      "x-computed": {
        status: { dependsOn: ["code"], binding: "status" },
        statusLabel: { dependsOn: ["status"], binding: "statusLabel" },
        hasCode: { dependsOn: ["code"], binding: "hasCode", releases: ["code"] },
        summary: { dependsOn: ["code", "rating"], binding: "summary", releases: ["code"] },
        nearBase: { dependsOn: ["location"], binding: "nearBase", releases: ["location"] }
      },
      "x-policy": { objectPolicy: "readers", propertyPolicies: { code: "officers", rating: "officers" } },
      "x-provenance": { properties: { location: { classification: "SECRET" } } }
    },
    { name: "test.Unit", version: "1.0.0", computedImplementations }
  );
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Base/1.0.0",
      title: "Base",
      type: "object",
      properties: { name: { type: "string" } },
      "x-relationships": { units: { target: "test.Unit", cardinality: "one-to-many", resolution: { dataSourceId: "ds", operation: "byForeignKey:baseId" } } },
      "x-policy": { objectPolicy: "readers" }
    },
    { name: "test.Base", version: "1.0.0" }
  );
  for (const typeName of ["test.Unit", "test.Base"]) {
    await registry.registerMapping({ id: `map-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  }

  const policy = new AbacPolicyEngine();
  policy.registerRule("readers", requireRole("reader"));
  policy.registerRule("officers", requireRole("officer"));
  policy.registerRule("anyone", allowAllRule);

  const adapter = new RepoAdapter();
  adapter.seed("test.Base", "b1", { name: "North" });
  adapter.seed("test.Unit", "u1", { name: "Alpha", baseId: "b1", code: "A", rating: 9, location: "Base North" });
  adapter.seed("test.Unit", "u2", { name: "Bravo", baseId: "b1", code: "C", rating: 2, location: "Field" });
  adapter.seed("test.Unit", "u3", { name: "Charlie", baseId: "b1", rating: 5, location: "Base North" });

  const runtime = new SemanticRuntime(registry, [adapter], policy, { classification: DEMO_LINEAR_CLASSIFICATION });
  return { runtime, registry, store };
}

const valuesOf = async (runtime: SemanticRuntime, id: string, who: Identity) => (await runtime.getObject("test.Unit", id, who)).values;

describe("Derived values inherit their inputs' read policy (ADR-0052)", () => {
  it("withholds a computed value from a caller who can't read its input, and only from them", async () => {
    const { runtime } = await setup();
    expect(await valuesOf(runtime, "u1", officer)).toMatchObject({ code: "A", status: "ready", statusLabel: "Status: ready" });
    const asReader = await valuesOf(runtime, "u1", reader);
    expect(asReader).not.toHaveProperty("code");
    expect(asReader).not.toHaveProperty("status");
  });

  it("follows a derivation through another computed value", async () => {
    const { runtime } = await setup();
    expect(await valuesOf(runtime, "u1", reader)).not.toHaveProperty("statusLabel");
  });

  it("withholds a value derived from a gated input even where the input has no value, since absence is disclosed too", async () => {
    const { runtime } = await setup();
    // u3 has no code: `status` would read "unknown" and so disclose that the officers-only field is empty.
    expect(await valuesOf(runtime, "u3", officer)).toMatchObject({ status: "unknown" });
    expect(await valuesOf(runtime, "u3", reader)).not.toHaveProperty("status");
  });

  it("lets a released input through, and only that input", async () => {
    const { runtime } = await setup();
    const asReader = await valuesOf(runtime, "u1", reader);
    expect(asReader.hasCode).toBe(true);
    // summary releases code but also derives from rating, which is not released.
    expect(asReader).not.toHaveProperty("summary");
    expect((await valuesOf(runtime, "u1", officer)).summary).toBe("true/9");
  });

  it("never releases a marking: classification still follows the derivation", async () => {
    const { runtime } = await setup();
    expect((await valuesOf(runtime, "u1", reader)).nearBase).toBe(true);
    const asUncleared = await valuesOf(runtime, "u1", uncleared);
    expect(asUncleared).not.toHaveProperty("location");
    expect(asUncleared).not.toHaveProperty("nearBase");
  });

  it("audits each withholding and each release, naming inputs but no values", async () => {
    const { runtime, store } = await setup();
    await valuesOf(runtime, "u1", reader);
    const rows = (await store.listAuditEvents({ limit: 1000 })).items.filter((r) => r.details?.control === "derivation");
    const byProperty: Record<string, (typeof rows)[number]> = Object.fromEntries(rows.map((r) => [r.resource.propertyPath ?? "", r]));
    expect(byProperty.status).toMatchObject({ decision: "deny", details: { inputs: ["code"] } });
    expect(byProperty.statusLabel).toMatchObject({ decision: "deny", details: { inputs: ["status"] } });
    expect(byProperty.summary).toMatchObject({ decision: "deny", details: { inputs: ["rating"] } });
    expect(byProperty.hasCode).toMatchObject({ decision: "allow", details: { released: ["code"] } });
    expect(JSON.stringify(rows)).not.toMatch(/"A"|ready|Base North/);
  });

  it("applies on query and include paths, where an include filter on a withheld value can't probe it", async () => {
    const { runtime } = await setup();
    const page = await runtime.query({ type: "test.Unit" }, reader);
    expect(page.items.every((i) => !("status" in i.values))).toBe(true);

    const probe = async (status: string, who: Identity) => {
      const [base] = (await runtime.query({ type: "test.Base", include: [{ relationship: "units", filter: { property: "status", operator: "eq", value: status } }] }, who)).items;
      return (base!.values.units as { objectId: string }[]).map((u) => u.objectId);
    };
    expect(await probe("ready", officer)).toEqual(["u1"]);
    expect(await probe("down", officer)).toEqual(["u2"]);
    // The reader learns nothing: every status value matches nothing.
    expect(await probe("ready", reader)).toEqual([]);
    expect(await probe("down", reader)).toEqual([]);
  });

  it("refuses provenance of a withheld value, and leaves a released input out of a released value's provenance", async () => {
    const { runtime } = await setup();
    await expect(runtime.getProvenance("test.Unit", "u1", "status", reader)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await runtime.getProvenance("test.Unit", "u1", "hasCode", reader)).toEqual([]);
    expect((await runtime.getProvenance("test.Unit", "u1", "hasCode", officer)).map((p) => p.propertyPath)).toEqual(["code"]);
  });

  it("refuses at registration a release of something the value doesn't depend on", async () => {
    const registry = new SemanticRegistry(new InMemoryRegistryStore());
    await expect(
      registry.registerType(
        {
          $id: "https://typesys.dev/types/test/Bad/1.0.0",
          title: "Bad",
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          "x-computed": { c: { dependsOn: ["a"], binding: "c", releases: ["b"] } }
        },
        { name: "test.Bad", version: "1.0.0", computedImplementations: { c: async () => 1 } }
      )
    ).rejects.toThrow(/releases "b", which it does not depend on/);
  });
});
