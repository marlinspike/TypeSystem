import { describe, expect, it } from "vitest";
import { AbacPolicyEngine, DEMO_LINEAR_CLASSIFICATION, InMemoryRegistryStore, InvalidInputError, SOURCE_WITHHELD, SemanticRegistry, SemanticRuntime, anyOf, requireAttributeMatch, requireRole, type Adapter, type Identity, type SemanticTypeSchema } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";

/**
 * What an explanation may say (ADR-0089), from the 5.0 pressure test: an
 * inspector explaining someone else is told only about what they may read
 * themselves, a caller's own explanation says nothing about whether a
 * withheld value exists, and every attempt is audited once and charged
 * once. A ward's staff read its patients; only an administrator reads a
 * patient's SSN, and only someone cleared SECRET their location.
 */
async function setup(options: Record<string, unknown> = {}) {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  const type = async (name: string, schema: Omit<SemanticTypeSchema, "$id" | "title" | "type">) =>
    registry.registerType({ $id: `https://typesys.dev/types/t/${name}/1.0.0`, title: name, type: "object", ...schema } as SemanticTypeSchema, { name: `t.${name}`, version: "1.0.0" });
  await type("Patient", {
    properties: { id: { type: "string" }, name: { type: "string" }, ward: { type: "string" }, ssn: { type: "string" }, location: { type: "string" }, bedId: { type: "string" } },
    "x-policy": { objectPolicy: "ward-staff", propertyPolicies: { ssn: "admins" } },
    "x-provenance": { properties: { location: { classification: "SECRET" } } },
    "x-relationships": { bed: { target: "t.Bed", cardinality: "many-to-one", resolution: { dataSourceId: "db", operation: "byOwnField:bedId" } } }
  });
  await type("Bed", {
    properties: { id: { type: "string" }, ward: { type: "string" } },
    "x-policy": { objectPolicy: "ward-staff" },
    "x-relationships": { patients: { target: "t.Patient", cardinality: "one-to-many", resolution: { dataSourceId: "db", operation: "byForeignKey:bedId" } } }
  });
  for (const t of ["t.Patient", "t.Bed"]) await registry.registerMapping({ id: `m-${t}`, typeName: t, target: "property", targetName: "*", dataSourceId: "db", operation: "get", resolutionMode: "live" });
  const db = new InMemoryRepositoryAdapter("db");
  db.seed("t.Patient", [
    { objectId: "P1", values: { id: "P1", name: "A", ward: "W1", ssn: "111", location: "X", bedId: "B1" } },
    { objectId: "P2", values: { id: "P2", name: "B", ward: "W2", bedId: "B1" } },
    { objectId: "P3", values: { id: "P3", name: "C", ward: "W2", ssn: "333", bedId: "B1" } },
    // A bed no source holds.
    { objectId: "P4", values: { id: "P4", name: "D", ward: "W1", bedId: "B9" } }
  ]);
  db.seed("t.Bed", [{ objectId: "B1", values: { id: "B1", ward: "W1" } }]);
  const policy = new AbacPolicyEngine();
  policy.registerRule("ward-staff", anyOf(requireRole("admin"), requireAttributeMatch("ward", "ward")));
  policy.registerRule("admins", requireRole("admin"));
  policy.registerRule("inspect", requireRole("auditor"));
  const runtime = new SemanticRuntime(registry, [db as unknown as Adapter], policy, { classification: DEMO_LINEAR_CLASSIFICATION, inspection: { policy: "inspect" }, ...options });
  return { registry, runtime };
}
const admin: Identity = { subjectId: "admin", roles: ["admin"], attributes: {}, clearance: "SECRET" };
// An inspector who works on ward W1, cleared CUI.
const auditor: Identity = { subjectId: "auditor", roles: ["auditor"], attributes: { ward: "W1" }, clearance: "CUI" };
const nurse: Identity = { subjectId: "nurse", roles: ["nurse"], attributes: { ward: "W2" }, clearance: "CUI" };
const nurseW1: Identity = { subjectId: "nurse-w1", roles: ["nurse"], attributes: { ward: "W1" }, clearance: "CUI" };

describe("an inspector explaining someone else is told only what they may read themselves", () => {
  it("counts another subject's rows and related objects among the investigator's own", async () => {
    const { runtime } = await setup();
    const q = await runtime.explain({ kind: "query", query: { type: "t.Patient" } }, auditor, { as: admin });
    expect(q.findings[0]!.reason).toBe("2 of the 2 objects you are returned on this page are returned to the subject");
    const r = await runtime.explain({ kind: "relationship", type: "t.Bed", id: "B1", relationship: "patients" }, auditor, { as: admin });
    expect(r.findings.find((f) => f.outcome === "returned")?.count).toBe(1);
  });

  it("says a value it may not read itself is not told, rather than that the subject is returned it", async () => {
    const { runtime } = await setup();
    const e = await runtime.explain({ kind: "read", type: "t.Patient", id: "P1" }, auditor, { as: admin });
    const outcome = (m: string) => e.findings.find((f) => f.member === m)?.outcome;
    expect([outcome("name"), outcome("ssn"), outcome("location")]).toEqual(["returned", "not-told", "not-told"]);
  });

  it("names a dangling reference although its own policy decides on values the missing object does not have", async () => {
    const { runtime } = await setup();
    const e = await runtime.explain({ kind: "relationship", type: "t.Patient", id: "P4", relationship: "bed" }, auditor, { as: nurseW1 });
    expect(e.findings).toContainEqual(expect.objectContaining({ about: "t.Bed/B9", outcome: "dangling" }));
  });

  it("lists no observed decision about a value its discovery withholds", async () => {
    const { runtime } = await setup({ discovery: "need-to-know" });
    await runtime.getObject("t.Patient", "P1", admin);
    const e = await runtime.explain({ kind: "read", type: "t.Patient", id: "P1" }, auditor, { as: admin });
    expect(e.observed.length).toBeGreaterThan(0);
    expect(e.observed.some((o) => o.member === "ssn" || o.member === "location")).toBe(false);
  });
});

describe("a caller's own explanation", () => {
  it("explains a withheld value as withheld whether or not the object holds one", async () => {
    const { runtime } = await setup();
    const ssn = async (id: string) => (await runtime.explain({ kind: "read", type: "t.Patient", id }, nurse)).findings.find((f) => f.member === "ssn")?.outcome;
    expect([await ssn("P2"), await ssn("P3")]).toEqual(["withheld", "withheld"]);
  });
});

describe("every explanation", () => {
  it("is charged to the investigator once", async () => {
    const counts: Record<string, number> = {};
    const { runtime } = await setup({ rateLimiter: { tryAcquire: (k: string) => ((counts[k] = (counts[k] ?? 0) + 1), true) } });
    await runtime.explain({ kind: "query", query: { type: "t.Patient" } }, auditor, { as: admin });
    expect(counts).toEqual({ auditor: 1 });
  });

  it("is audited with the subject it was about, when it is refused too", async () => {
    const { runtime, registry } = await setup();
    await expect(runtime.explain({ kind: "read", type: "t.Patient", id: "P2" }, auditor, { as: admin })).rejects.toThrow();
    const rows = (await registry.listAuditEvents({ limit: 100 })).items.filter((r) => r.action === "explain");
    expect(rows.some((r) => r.decision === "deny" && (r.details as { subject?: string } | undefined)?.subject === "admin")).toBe(true);
  });

  it("refuses a malformed question as invalid input", async () => {
    const { runtime } = await setup();
    for (const q of [null, {}, { kind: "bogus" }, { kind: "read", type: "t.Patient" }, { kind: "relationship", type: "t.Bed", id: "B1" }]) await expect(runtime.explain(q as never, auditor)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("a query plan", () => {
  it("names the sources only to an inspector (ADR-0088)", async () => {
    const { runtime } = await setup();
    const scan = async (who: Identity) => (await runtime.explainQuery({ type: "t.Patient" }, who)).execution.steps.find((s) => s.op === "scan") as { dataSourceId: string };
    expect((await scan(auditor)).dataSourceId).toBe("db");
    expect((await scan(nurse)).dataSourceId).toBe(SOURCE_WITHHELD);
  });
});
