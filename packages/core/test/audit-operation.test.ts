import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime, type RuntimeOperation } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { computeAggregations } from "../src/runtime/query-ops.js";
import { parseResolution } from "../src/runtime/resolution.js";
import { AbacPolicyEngine, allowAllRule, requireAttributeMatch, requireRole } from "../src/policy/abac-policy-engine.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { RelationshipDefinition } from "../src/model/relationship.js";
import type { AggregateResult, QueryFilter, SemanticAggregateQuery } from "../src/model/query.js";
import type { Identity } from "../src/model/policy.js";

/**
 * ADR-0042: every audit row names the runtime operation it was written under
 * — the outermost call — so a `listActions` preview is told apart from an
 * `invokeAction` gate, and a decision inside a query from a direct read.
 */
const DATA: Record<string, Record<string, Record<string, unknown>>> = {
  "test.Case": { c1: { id: "c1", ownerId: "alice", title: "Leak" }, c2: { id: "c2", ownerId: "bob", title: "Badge" } },
  "test.Note": { n1: { id: "n1", caseId: "c1", text: "photos" }, n2: { id: "n2", caseId: "c2", text: "reissued" } }
};

class Store implements Adapter {
  readonly dataSourceId = "ds";
  private rows(type: string) {
    return Object.entries(DATA[type] ?? {}).map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: [] }));
  }
  async resolveProperties(type: string, id: string): Promise<ResolvedProperties> {
    const values = DATA[type]?.[id] ?? {};
    return { values: { ...values }, provenance: Object.keys(values).map((f) => ({ propertyPath: f, source: { dataSourceId: "ds", system: "ds", recordId: id, field: f }, retrievedAt: "2026-01-01T00:00:00.000Z" })) };
  }
  async queryByType(type: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    return { items: this.rows(type).filter((r) => matchesFilter(r.values, filter)) };
  }
  async resolveRelationship(rel: RelationshipDefinition, source: string): Promise<RelatedRef[]> {
    const strategy = parseResolution(rel.resolution.operation);
    if (strategy.kind === "byOwnField") return [{ objectId: String(DATA[rel.sourceType]?.[source]?.[strategy.field]) }];
    return this.rows(rel.targetType).filter((r) => strategy.kind === "byForeignKey" && r.values[strategy.field] === source).map((r) => ({ objectId: r.objectId }));
  }
  async aggregate(query: SemanticAggregateQuery): Promise<AggregateResult> {
    return computeAggregations(this.rows(query.type).map((r) => r.values).filter((v) => matchesFilter(v, query.filter)), query);
  }
  async executeAction(): Promise<unknown> {
    return { closed: true };
  }
}

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Case/1.0.0",
      type: "object",
      title: "Case",
      properties: { id: { type: "string" }, ownerId: { type: "string" }, title: { type: "string" } },
      "x-relationships": { notes: { target: "test.Note", cardinality: "one-to-many", resolution: { dataSourceId: "ds", operation: "byForeignKey:caseId" } } },
      "x-policy": { objectPolicy: "case.read" }
    },
    { name: "test.Case", version: "1.0.0" }
  );
  await registry.registerType(
    {
      $id: "https://typesys.dev/types/test/Note/1.0.0",
      type: "object",
      title: "Note",
      properties: { id: { type: "string" }, caseId: { type: "string" }, text: { type: "string" } },
      "x-relationships": { case: { target: "test.Case", cardinality: "one-to-one", resolution: { dataSourceId: "ds", operation: "byOwnField:caseId" } } },
      "x-policy": { objectPolicy: "public" }
    },
    { name: "test.Note", version: "1.0.0" }
  );
  for (const t of ["Case", "Note"]) {
    await registry.registerMapping({ id: `m-${t}`, typeName: `test.${t}`, target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });
  }
  await registry.registerAction({
    id: "action-close",
    name: "CloseCase",
    description: "Closes a case.",
    applicableTypes: ["test.Case"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authorizationPolicy: "staff",
    implementation: { dataSourceId: "ds", operation: "close" },
    sideEffects: "mutates",
    idempotency: "none",
    auditRequired: true,
    version: "1.0.0"
  });
  const engine = new AbacPolicyEngine();
  engine.registerRule("public", allowAllRule);
  engine.registerRule("case.read", requireAttributeMatch("ownerId", "userId"));
  engine.registerRule("staff", requireRole("staff"));
  return { runtime: new SemanticRuntime(registry, [new Store()], engine), registry };
}

const alice: Identity = { subjectId: "alice", roles: ["staff"], attributes: { userId: "alice" } };
const guest: Identity = { subjectId: "guest", roles: [], attributes: {} };

describe("audit rows name the operation (ADR-0042)", () => {
  it("every row every operation writes names it — the outermost call, nested decisions included", async () => {
    const { runtime, registry } = await setup();
    const ran: RuntimeOperation[] = [];
    const run = async (operation: RuntimeOperation, fn: () => Promise<unknown>) => {
      ran.push(operation);
      await fn().catch(() => undefined);
      const rows = (await registry.listAuditEvents({ limit: 1000 })).items;
      const fresh = rows.filter((r) => !seen.has(r.id));
      for (const r of fresh) seen.add(r.id);
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.map((r) => r.operation)).toEqual(fresh.map(() => operation));
    };
    const seen = new Set<string>();

    await run("getObject", () => runtime.getObject("test.Case", "c2", alice));
    await run("getRelationship", () => runtime.getRelationship("test.Note", "n2", "case", alice)); // the target c2 is decided inside
    await run("getProvenance", () => runtime.getProvenance("test.Case", "c1", "title", alice));
    await run("query", () => runtime.query({ type: "test.Note", include: [{ relationship: "case" }] }, alice)); // include targets decided inside
    await run("aggregate", () => runtime.aggregate({ type: "test.Case", aggregations: [{ name: "n", op: "count" }] }, alice));
    await run("explainQuery", () => runtime.explainQuery({ type: "test.Case" }, alice));
    await run("listActions", () => runtime.listActions("test.Case", guest));
    await run("invokeAction", () => runtime.invokeAction("CloseCase", {}, alice)); // the gate and the outcome row
    expect(new Set(ran).size).toBe(8);
  });

  it("a listActions preview is told apart from the invocation it previews", async () => {
    const { runtime, registry } = await setup();
    await runtime.listActions("test.Case", guest);
    await runtime.invokeAction("CloseCase", {}, guest).catch(() => undefined);
    const denials = (await registry.listAuditEvents({ limit: 100 })).items.filter((r) => r.action === "CloseCase" && r.decision === "deny");
    expect(denials.map((r) => r.operation).sort()).toEqual(["invokeAction", "listActions"]);
  });
});
