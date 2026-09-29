import { describe, it, expect } from "vitest";
import { SemanticRegistry } from "../src/registry/registry.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";
import { SemanticRuntime } from "../src/runtime/runtime.js";
import { matchesFilter } from "../src/runtime/filter.js";
import { AbacPolicyEngine, allowAllRule, requireRole, type PolicyRule } from "../src/policy/abac-policy-engine.js";
import { AuthorizationError } from "../src/runtime/errors.js";
import type { Adapter, AdapterQueryResult, RelatedRef, ResolvedProperties } from "../src/runtime/adapter.js";
import type { QueryFilter } from "../src/model/query.js";
import type { ProvenanceRef } from "../src/model/provenance.js";
import type { Identity } from "../src/model/policy.js";
import type { SemanticTypeSchema } from "../src/model/vocabulary.js";

/**
 * Broadens property-level policy coverage beyond the two demo-domain fields
 * (`Aircraft.maintenanceStatus`, `Patient.medicalRecordNumber`): several gated
 * fields, both role- and attribute-based, exercised across every read path —
 * getObject redaction, getProvenance denial, query projection, and fail-closed
 * filtering — with partial per-caller visibility. (PRODUCTION-READINESS item.)
 */
class RepoAdapter implements Adapter {
  readonly dataSourceId = "ds";
  private readonly data = new Map<string, Record<string, unknown>>();

  seed(id: string, values: Record<string, unknown>): void {
    this.data.set(id, values);
  }
  private prov(id: string, values: Record<string, unknown>): ProvenanceRef[] {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: "ds", system: "ds", recordId: id, field },
      retrievedAt: "2026-01-01T00:00:00.000Z",
      confidence: 1
    }));
  }
  async resolveProperties(_typeName: string, id: string): Promise<ResolvedProperties> {
    const v = this.data.get(id) ?? {};
    return { values: { ...v }, provenance: this.prov(id, v) };
  }
  async queryByType(_typeName: string, filter?: QueryFilter): Promise<AdapterQueryResult> {
    const items = [...this.data.entries()].map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(objectId, values) }));
    const filtered = filter ? items.filter((i) => matchesFilter(i.values, filter)) : items;
    return { items: filtered };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

// Attribute-based (ABAC) property policy: allow only callers whose region attribute is "us".
const usOnly: PolicyRule = (req) =>
  req.subject.attributes?.region === "us" ? { allow: true } : { allow: false, reason: "region is not us" };

const manager: Identity = { subjectId: "m", roles: ["manager"], attributes: { region: "us" } };
const hr: Identity = { subjectId: "h", roles: ["hr"], attributes: { region: "eu" } };
const plain: Identity = { subjectId: "p", roles: [], attributes: { region: "us" } };

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const schema: SemanticTypeSchema = {
    $id: "https://typesys.dev/types/test/Emp/1.0.0",
    title: "Emp",
    type: "object",
    properties: {
      name: { type: "string" },
      salary: { type: "number" },
      ssn: { type: "string" },
      region: { type: "string" }
    },
    "x-policy": {
      objectPolicy: "public",
      propertyPolicies: { salary: "managers-only", ssn: "hr-only", region: "us-only" }
    }
  };
  await registry.registerType(schema, { name: "test.Emp", version: "1.0.0" });
  await registry.registerMapping({ id: "map-emp", typeName: "test.Emp", target: "property", targetName: "*", dataSourceId: "ds", operation: "get", resolutionMode: "live" });

  const policyEngine = new AbacPolicyEngine();
  policyEngine.registerRule("public", allowAllRule);
  policyEngine.registerRule("managers-only", requireRole("manager"));
  policyEngine.registerRule("hr-only", requireRole("hr"));
  policyEngine.registerRule("us-only", usOnly);

  const adapter = new RepoAdapter();
  adapter.seed("e1", { name: "Alice", salary: 100, ssn: "111-22-3333", region: "restricted" });

  const runtime = new SemanticRuntime(registry, [adapter], policyEngine);
  return { runtime };
}

describe("Property-level policy across read paths (ADR-0009)", () => {
  it("redacts each field independently per caller in getObject", async () => {
    const { runtime } = await setup();

    // manager: role opens salary, region attribute is us → region; hr-only ssn stays hidden.
    expect(Object.keys((await runtime.getObject("test.Emp", "e1", manager)).values).sort()).toEqual(["name", "region", "salary"]);
    // hr: role opens ssn; not a manager (no salary); eu region → no region.
    expect(Object.keys((await runtime.getObject("test.Emp", "e1", hr)).values).sort()).toEqual(["name", "ssn"]);
    // plain: only the us-attribute field and the public one.
    expect(Object.keys((await runtime.getObject("test.Emp", "e1", plain)).values).sort()).toEqual(["name", "region"]);
  });

  it("allows getProvenance on a readable property but denies a hidden one", async () => {
    const { runtime } = await setup();
    await expect(runtime.getProvenance("test.Emp", "e1", "salary", manager)).resolves.toHaveLength(1);
    await expect(runtime.getProvenance("test.Emp", "e1", "salary", plain)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("redacts hidden properties even when explicitly projected", async () => {
    const { runtime } = await setup();
    const asManager = (await runtime.query({ type: "test.Emp", select: ["salary", "ssn", "region"] }, manager)).items[0]!;
    expect(Object.keys(asManager.values).sort()).toEqual(["region", "salary"]); // ssn (hr-only) can't be projected in
  });

  it("only reports provenance for the caller's visible properties", async () => {
    const { runtime } = await setup();
    const item = (await runtime.query({ type: "test.Emp", includeProvenance: true }, hr)).items[0]!;
    const paths = (item.provenance ?? []).map((p) => p.propertyPath).sort();
    expect(paths).toEqual(["name", "ssn"]); // never salary or region
  });

  it("fails a filter on a hidden property closed, but allows it for an authorized caller", async () => {
    const { runtime } = await setup();
    await expect(runtime.query({ type: "test.Emp", filter: { property: "salary", operator: "gte", value: 50 } }, plain)).rejects.toBeInstanceOf(AuthorizationError);
    const ok = await runtime.query({ type: "test.Emp", filter: { property: "salary", operator: "gte", value: 50 } }, manager);
    expect(ok.items.map((i) => i.objectId)).toEqual(["e1"]);
  });
});
