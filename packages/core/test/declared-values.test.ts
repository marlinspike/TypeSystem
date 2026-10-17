import { describe, expect, it } from "vitest";
import { AbacPolicyEngine, InMemoryRegistryStore, SemanticRegistry, SemanticRuntime, requireRole, type Adapter, type AdapterQueryResult, type Identity, type ResolvedProperties } from "../src/index.js";

/**
 * A read returns only what the model declares (ADR-0095). A source that
 * returns a column the model does not name, because it was added to the
 * source or dropped from the model, has no policy, marking or contract on
 * it, so it is never returned, filtered on or sorted by.
 */
const ROWS: Record<string, Record<string, unknown>> = {
  "P-1": { id: "P-1", displayName: "Jordan Lee", ward: "4B", ssn: "123-45-6789" },
  "P-2": { id: "P-2", displayName: "Amara Okafor", ward: "2A", ssn: "987-65-4321" }
};

const bundle = (id: string): ResolvedProperties => {
  const values = { ...ROWS[id] };
  return { values, provenance: Object.keys(values).map((propertyPath) => ({ propertyPath, source: { dataSourceId: "records", system: "records", recordId: id }, retrievedAt: "2026-10-17T00:00:00.000Z" })) };
};

class Records implements Partial<Adapter> {
  readonly dataSourceId = "records";
  async resolveProperties(_t: string, id: string): Promise<ResolvedProperties> {
    return bundle(id);
  }
  async queryByType(): Promise<AdapterQueryResult> {
    return { items: Object.keys(ROWS).map((objectId) => ({ objectId, ...bundle(objectId) })) };
  }
  async resolveRelationship() {
    return [];
  }
}

async function setup() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType({ $id: "https://typesys.dev/types/test/Party/1.0.0", title: "Party", type: "object", properties: { id: { type: "string" }, displayName: { type: "string" } } }, { name: "test.Party", version: "1.0.0" });
  await registry.registerType(
    { $id: "https://typesys.dev/types/test/Patient/1.0.0", title: "Patient", type: "object", properties: { ward: { type: "string" } }, "x-policy": { objectPolicy: "staff" } },
    { name: "test.Patient", version: "1.0.0", extends: "test.Party" }
  );
  await registry.registerMapping({ id: "m", typeName: "test.Patient", target: "property", targetName: "*", dataSourceId: "records", operation: "get", resolutionMode: "live" });
  const policy = new AbacPolicyEngine();
  policy.registerRule("staff", requireRole("staff"));
  return new SemanticRuntime(registry, [new Records() as unknown as Adapter], policy);
}
const staff: Identity = { subjectId: "nurse", roles: ["staff"], attributes: {} };

describe("a read returns only what the model declares (ADR-0095)", () => {
  it("drops a column no Type in the chain declares, from the values and the provenance, and keeps inherited ones", async () => {
    const runtime = await setup();
    const read = await runtime.getObject("test.Patient", "P-1", staff, { includeProvenance: true });
    expect(Object.keys(read.values).sort()).toEqual(["displayName", "id", "ward"]);
    expect(read.provenance!.map((p) => p.propertyPath)).not.toContain("ssn");
    const listed = await runtime.query({ type: "test.Patient" }, staff);
    expect(listed.items.every((o) => !("ssn" in o.values))).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("123-45-6789");
  });

  it("refuses a filter or a sort on an undeclared column, so it cannot be probed one value at a time", async () => {
    const runtime = await setup();
    await expect(runtime.query({ type: "test.Patient", filter: { property: "ssn", operator: "eq", value: "123-45-6789" } }, staff)).rejects.toThrow();
    await expect(runtime.query({ type: "test.Patient", sort: [{ property: "ssn", direction: "asc" }] }, staff)).rejects.toThrow();
  });
});
