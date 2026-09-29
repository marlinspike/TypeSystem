import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { applySort } from "../src/runtime/query-ops.js";
import { AbacPolicyEngine, allowAllRule, requireRole } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError, InvalidInputError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter, SortKey } from "../src/model/query.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/** Minimal repository adapter reusing core's own shared filter/sort interpreters (no cross-package import). */
class RepoAdapter implements Adapter {
  readonly dataSourceId = "ds";
  private readonly data = new Map<string, Map<string, Record<string, unknown>>>();

  seed(type: string, records: { objectId: string; values: Record<string, unknown> }[]): void {
    const m = this.data.get(type) ?? new Map<string, Record<string, unknown>>();
    for (const r of records) m.set(r.objectId, r.values);
    this.data.set(type, m);
  }

  private prov(objectId: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: "ds", recordId: objectId, field },
      retrievedAt: "2026-01-01T00:00:00.000Z",
      confidence: 1
    }));
  }

  async resolveProperties(typeName: string, objectId: string): Promise<ResolvedProperties> {
    const v = this.data.get(typeName)?.get(objectId) ?? {};
    return { values: { ...v }, provenance: this.prov(objectId, v) };
  }

  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[]): Promise<AdapterQueryResult> {
    const all = [...(this.data.get(typeName)?.entries() ?? [])].map(([objectId, values]) => ({ objectId, values }));
    const filtered = filter ? all.filter((r) => matchesFilter(r.values, filter)) : all;
    const sorted = applySort(filtered, sort, (r) => r.values);
    const start = cursor ? Number(cursor) : 0;
    const size = limit ?? sorted.length;
    const page = sorted.slice(start, start + size);
    const nextCursor = start + size < sorted.length ? String(start + size) : undefined;
    return {
      items: page.map((r) => ({ objectId: r.objectId, values: { ...r.values }, provenance: this.prov(r.objectId, r.values) })),
      nextCursor
    };
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const field = relationship.resolution.operation.split(":")[1]!;
    return [...(this.data.get(relationship.targetType)?.entries() ?? [])]
      .filter(([, v]) => v[field] === sourceObjectId)
      .map(([objectId]) => ({ objectId }));
  }

  async executeAction(): Promise<unknown> {
    throw new Error("no actions in this adapter");
  }
}

const identity: Identity = { subjectId: "u1", roles: [], attributes: {} }; // not a manager

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());

  const itemSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Item/1.0.0",
    title: "Item",
    type: "object",
    properties: {
      name: { type: "string" },
      rank: { type: "number" },
      salary: { type: "number" },
      boxId: { type: "string" }
    },
    "x-computed": { doubled: { dependsOn: ["rank"], binding: "doubled" } },
    "x-policy": { objectPolicy: "public", propertyPolicies: { salary: "managers-only" } }
  };
  await registry.registerType(itemSchema, {
    name: "test.Item",
    version: "1.0.0",
    computedImplementations: { doubled: async (ctx) => ((await ctx.getProperty("rank")) as number) * 2 }
  });

  const boxSchema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Box/1.0.0",
    title: "Box",
    type: "object",
    properties: { id: { type: "string" } },
    "x-relationships": {
      items: { target: "test.Item", cardinality: "one-to-many", resolution: { dataSourceId: "ds", operation: "byForeignKey:boxId" } }
    },
    "x-policy": { objectPolicy: "public" }
  };
  await registry.registerType(boxSchema, { name: "test.Box", version: "1.0.0" });

  for (const typeName of ["test.Item", "test.Box"]) {
    await registry.registerMapping({ id: `map-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  }

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("managers-only", requireRole("manager"));

  const adapter = new RepoAdapter();
  adapter.seed("test.Item", [
    { objectId: "i1", values: { name: "bravo", rank: 2, salary: 100, boxId: "b1" } },
    { objectId: "i2", values: { name: "alpha", rank: 3, salary: 200, boxId: "b1" } },
    { objectId: "i3", values: { name: "alpha", rank: 1, salary: 300, boxId: "b1" } }
  ]);
  adapter.seed("test.Box", [{ objectId: "b1", values: { id: "b1" } }]);

  const runtime = new SemanticRuntime(registry, [adapter], policyEngine);
  return { runtime };
}

const ids = (r: { items: { objectId: string }[] }) => r.items.map((i) => i.objectId);

describe("Query sort (ADR-0027)", () => {
  it("orders ascending and descending by a key", async () => {
    const { runtime } = await setup();
    expect(ids(await runtime.query({ type: "test.Item", sort: [{ property: "rank", direction: "asc" }] }, identity))).toEqual(["i3", "i1", "i2"]);
    expect(ids(await runtime.query({ type: "test.Item", sort: [{ property: "rank", direction: "desc" }] }, identity))).toEqual(["i2", "i1", "i3"]);
  });

  it("applies multi-key sort in priority order", async () => {
    const { runtime } = await setup();
    // name asc groups the two "alpha"s first; rank desc orders within that group (i2 rank 3 before i3 rank 1).
    const r = await runtime.query({ type: "test.Item", sort: [{ property: "name" }, { property: "rank", direction: "desc" }] }, identity);
    expect(ids(r)).toEqual(["i2", "i3", "i1"]);
  });

  it("rejects a top-level sort on a computed property", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "test.Item", sort: [{ property: "doubled" }] }, identity)).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("denies a sort on a property the caller cannot read (fail closed)", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "test.Item", sort: [{ property: "salary" }] }, identity)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("Query projection (ADR-0027)", () => {
  it("returns only the selected own properties", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Item", select: ["name"] }, identity);
    expect(r.items.every((i) => Object.keys(i.values).length === 1 && "name" in i.values)).toBe(true);
  });

  it("can select a computed property", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Item", filter: { property: "name", operator: "eq", value: "bravo" }, select: ["doubled"] }, identity);
    expect(r.items[0]!.values).toEqual({ doubled: 4 }); // bravo has rank 2
  });

  it("cannot reveal a redacted property by selecting it", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Item", select: ["name", "salary"] }, identity);
    expect(r.items.every((i) => !("salary" in i.values))).toBe(true);
  });

  it("filters provenance to the projected properties", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Item", select: ["name"], includeProvenance: true }, identity);
    expect(r.items.every((i) => (i.provenance ?? []).every((p) => p.propertyPath === "name"))).toBe(true);
  });

  it("keeps requested includes even under a top-level projection", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Box", select: ["id"], include: [{ relationship: "items" }] }, identity);
    const box = r.items[0]!;
    expect("id" in box.values).toBe(true);
    expect((box.values.items as unknown[]).length).toBe(3);
  });

  it("projects included objects with a per-include select", async () => {
    const { runtime } = await setup();
    const r = await runtime.query({ type: "test.Box", include: [{ relationship: "items", select: ["name"] }] }, identity);
    const items = r.items[0]!.values.items as { values: Record<string, unknown> }[];
    expect(items.every((i) => Object.keys(i.values).length === 1 && "name" in i.values)).toBe(true);
  });
});
