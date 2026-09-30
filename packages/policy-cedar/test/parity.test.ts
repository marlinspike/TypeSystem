import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { AuthorizationError, DEMO_LINEAR_CLASSIFICATION, SemanticRuntime, type Adapter, type AuditEvent, type Identity, type PolicyEngine, type SemanticRegistry } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities } from "@typesys/domain-hospital";
import { CedarPolicyEngine } from "../src/index.js";

/**
 * The drop-in proof (ADR-0031): each demo domain runs twice over identical
 * data — once on its own `AbacPolicyEngine` rules, once on `CedarPolicyEngine`
 * with `examples/demo-domains.cedar` — and every read path, for every object,
 * property, relationship, and the Action, for every identity below, must give
 * the same result *and* the same audited decision at every policy checkpoint.
 * Nothing in the runtime knows which engine it has.
 */
const SCHEMA = readFileSync(new URL("../examples/demo-domains.cedarschema", import.meta.url), "utf8");
const POLICIES = readFileSync(new URL("../examples/demo-domains.cedar", import.meta.url), "utf8");
const cedarEngine = () => new CedarPolicyEngine({ schema: SCHEMA, policies: POLICIES });
const CLASSIFIED = { classification: DEMO_LINEAR_CLASSIFICATION };

const identity = (subjectId: string, roles: string[], attributes: Record<string, unknown> = {}): Identity => ({ subjectId, roles, attributes });

/** The demo identities, plus the edge cases where two engines are likeliest to disagree. */
const IDENTITIES: Record<string, Identity> = {
  maintainer: demoIdentities.maintainer,
  viewer: demoIdentities.viewer,
  anonymous: demoIdentities.anonymous,
  clinician: hospitalDemoIdentities.clinician,
  otherClinician: hospitalDemoIdentities.otherClinician,
  patient: hospitalDemoIdentities.patient,
  admin: identity("user-admin-1", ["admin"]),
  unlinkedClinician: identity("c-unlinked", ["clinician"]),
  emptyProviderClinician: identity("c-empty", ["clinician"], { providerId: "" }),
  emptyPatient: identity("p-empty", ["patient"], { patientId: "" }),
  tokenClinician: identity("c-token", ["clinician"], { providerId: "PR-2002", iss: "https://idp.example", aud: ["typesys"], exp: 1790000000, nested: { a: 1 }, ratio: 0.5, gone: null }),
  nullProviderClinician: identity("c-null", ["clinician"], { providerId: null }),
  everyRole: identity("u-every", ["maintainer", "viewer", "clinician", "patient"], { providerId: "PR-2002", patientId: "PT-1001" }),
  spoofedRole: identity("u-spoof", ['admin"', "Admin", " clinician"], { providerId: "PR-2001" })
};

/** Patients that probe the own-patient rule's edges: no assigned clinician, an empty one, an empty own id. */
const EDGE_PATIENTS = [
  { objectId: "PT-1003", values: { id: "PT-1003", name: "Unassigned", medicalRecordNumber: "MRN-1003" } },
  { objectId: "PT-1004", values: { id: "PT-1004", name: "Empty assignee", medicalRecordNumber: "MRN-1004", assignedClinicianId: "" } },
  { objectId: "PT-1005", values: { id: "", name: "Empty id", medicalRecordNumber: "MRN-1005", assignedClinicianId: "PR-2002" } }
];

interface World {
  runtime: SemanticRuntime;
  decisions: string[];
}

/** Records every audited decision, as a comparable line, into `decisions`. */
function recordDecisions(registry: SemanticRegistry): string[] {
  const decisions: string[] = [];
  const append = registry.appendAuditEvent.bind(registry);
  registry.appendAuditEvent = async (e: AuditEvent) => {
    decisions.push(`${e.subjectId} ${e.action} ${e.resource.typeName}/${e.resource.objectId ?? ""}#${e.resource.propertyPath ?? ""} ${e.decision}`);
    return append(e);
  };
  return decisions;
}

interface Pair {
  abac: World;
  cedar: World;
  /** Every object id per Type, read straight from the adapters — beneath policy, so every object is exercised. */
  objects: Map<string, { id: string; properties: string[] }[]>;
  registry: SemanticRegistry;
  domain: string;
}

/**
 * An engine with its planner hidden (ADR-0038). A planning runtime reads fewer
 * objects — so makes fewer decisions — than one that decides every row, and
 * the two engines plan differently (ADR-0039); parity is about the decisions,
 * so both sides decide every row. What planning does to results is compared in
 * `planning-parity.test.ts`.
 */
const withoutPlanner = (engine: PolicyEngine): PolicyEngine => ({ evaluate: (request) => engine.evaluate(request) });

async function pairOf(domain: string, build: () => Promise<{ registry: SemanticRegistry; policyEngine: PolicyEngine; adapters: Adapter[] }>): Promise<Pair> {
  const [a, c] = [await build(), await build()];
  const abac = { runtime: new SemanticRuntime(a.registry, a.adapters, withoutPlanner(a.policyEngine), CLASSIFIED), decisions: recordDecisions(a.registry) };
  // Only the engine differs: the same classification scheme the ABAC testbeds configure (ADR-0034).
  const cedar = { runtime: new SemanticRuntime(c.registry, c.adapters, withoutPlanner(cedarEngine()), CLASSIFIED), decisions: recordDecisions(c.registry) };

  const objects = new Map<string, { id: string; properties: string[] }[]>();
  for (const typeDef of (await a.registry.listTypes()).filter((t) => t.name.startsWith(`${domain}.`))) {
    const base = (await a.registry.listMappings(typeDef.name)).find((m) => m.target === "property" && m.targetName === "*")!;
    const adapter = a.adapters.find((ad) => ad.dataSourceId === base.dataSourceId)!;
    const { items } = await adapter.queryByType(typeDef.name, undefined, 1000);
    objects.set(
      typeDef.name,
      items.map((i) => ({ id: i.objectId, properties: [...Object.keys(i.values), ...typeDef.computedProperties.map((cp) => cp.name)] }))
    );
  }
  return { abac, cedar, objects, registry: a.registry, domain };
}

const hospital = () =>
  pairOf("hospital", async () => {
    const tb = await buildHospitalTestbed();
    tb.adapter.seed("hospital.Patient", EDGE_PATIENTS);
    return { registry: tb.registry, policyEngine: tb.policyEngine, adapters: [tb.adapter] };
  });

const airforce = () =>
  pairOf("airforce", async () => {
    const tb = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
    return { registry: tb.registry, policyEngine: tb.policyEngine, adapters: [tb.inMemoryAdapter, tb.mockRestAdapter] };
  });

type Scenario = { label: string; run: (runtime: SemanticRuntime) => Promise<unknown> };

/** Every read path over every object, property, and relationship of the domain, then its Action — as one identity. */
async function scenariosFor(pair: Pair, who: Identity): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const add = (label: string, run: Scenario["run"]) => scenarios.push({ label, run });

  for (const [typeName, objects] of pair.objects) {
    const typeDef = (await pair.registry.getType(typeName))!;
    const gated = Object.keys(typeDef.schema["x-policy"]?.propertyPolicies ?? {});
    add(`query ${typeName}`, (rt) => rt.query({ type: typeName }, who));
    add(`aggregate ${typeName}`, (rt) => rt.aggregate({ type: typeName, aggregations: [{ name: "n", op: "count" }] }, who));
    add(`listActions ${typeName}`, (rt) => rt.listActions(typeName, who));
    for (const property of gated) {
      add(`filter ${typeName}.${property}`, (rt) => rt.query({ type: typeName, filter: { property, operator: "eq", value: "x" } }, who));
    }
    for (const rel of typeDef.relationships) {
      add(`include ${typeName}.${rel.name}`, (rt) => rt.query({ type: typeName, include: [{ relationship: rel.name }] }, who));
    }
    for (const { id, properties } of objects) {
      add(`getObject ${typeName}/${id}`, (rt) => rt.getObject(typeName, id, who, { includeProvenance: true }));
      for (const rel of typeDef.relationships) add(`getRelationship ${typeName}/${id}.${rel.name}`, (rt) => rt.getRelationship(typeName, id, rel.name, who));
      for (const property of properties) add(`getProvenance ${typeName}/${id}.${property}`, (rt) => rt.getProvenance(typeName, id, property, who));
    }
  }
  if (pair.domain === "airforce") {
    add("invoke CreateMaintenanceWorkOrder", (rt) => rt.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001", assignedTo: "parity" }, who));
    add("invoke with bad input", (rt) => rt.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-9001" }, who));
    add("invoke with a failing precondition", (rt) => rt.invokeAction("CreateMaintenanceWorkOrder", { maintenanceEventId: "EVT-NOPE", assignedTo: "parity" }, who));
  }
  return scenarios;
}

/** Wall-clock values that legitimately differ between two runs of the same read. */
const VOLATILE_KEYS = new Set(["retrievedAt", "createdAt"]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !VOLATILE_KEYS.has(k)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

/** A result, or the error class and message — never the reason, which names each engine's own rule. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: stable(await run()) };
  } catch (err) {
    return { error: (err as Error).name, message: (err as Error).message };
  }
}

const tally = { scenarios: 0, allows: 0, denies: 0 };

async function expectParity(pair: Pair, who: Identity): Promise<void> {
  const mismatches: unknown[] = [];
  for (const scenario of await scenariosFor(pair, who)) {
    pair.abac.decisions.length = 0;
    pair.cedar.decisions.length = 0;
    const expected = await outcome(() => scenario.run(pair.abac.runtime));
    const actual = await outcome(() => scenario.run(pair.cedar.runtime));
    const abacDecisions = [...pair.abac.decisions].sort();
    const cedarDecisions = [...pair.cedar.decisions].sort();

    tally.scenarios++;
    tally.allows += abacDecisions.filter((d) => d.endsWith(" allow")).length;
    tally.denies += abacDecisions.filter((d) => d.endsWith(" deny")).length;
    if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify(abacDecisions) !== JSON.stringify(cedarDecisions)) {
      mismatches.push({ scenario: scenario.label, abac: { result: expected, decisions: abacDecisions }, cedar: { result: actual, decisions: cedarDecisions } });
    }
  }
  expect(mismatches).toEqual([]);
}

describe("parity: CedarPolicyEngine decides exactly as AbacPolicyEngine (ADR-0031)", () => {
  for (const [domain, build] of [["hospital", hospital], ["airforce", airforce]] as const) {
    describe(`${domain} domain`, () => {
      let pair: Pair;
      it("builds both worlds", async () => {
        pair = await build();
        expect(pair.objects.size).toBeGreaterThan(2);
      });
      for (const [name, who] of Object.entries(IDENTITIES)) {
        it(`as ${name}: same results and the same decision at every checkpoint`, async () => {
          await expectParity(pair, who);
        });
      }
    });
  }

  it("the matrix is not vacuous: thousands of scenarios, with both engines allowing and denying plenty", () => {
    expect(tally.scenarios).toBeGreaterThan(2000);
    expect(tally.allows).toBeGreaterThan(1000);
    expect(tally.denies).toBeGreaterThan(1000);
  });
});

describe("row-level authorization under Cedar (ADR-0030 + ADR-0031)", () => {
  async function cedarHospital() {
    const tb = await buildHospitalTestbed();
    return { registry: tb.registry, runtime: new SemanticRuntime(tb.registry, [tb.adapter], cedarEngine(), CLASSIFIED) };
  }
  const { clinician: clinicianA, otherClinician: clinicianB } = hospitalDemoIdentities;
  const ids = (objs: { objectId: string }[]) => objs.map((o) => o.objectId).sort();

  it("the decision is Cedar's: the audit names the Cedar policy that permitted the read", async () => {
    const { registry, runtime } = await cedarHospital();
    await runtime.getObject("hospital.Patient", "PT-1001", clinicianA);
    const row = (await registry.listAuditEvents({ limit: 10 })).items.find((e) => e.resource.objectId === "PT-1001" && !e.resource.propertyPath);
    expect(row?.reason).toBe("Permitted by hospital.read-patient.assigned-clinician");
  });

  it("attack: clinician B cannot read clinician A's patient by getObject, query, include, provenance, or aggregation", async () => {
    const { runtime } = await cedarHospital();
    await expect(runtime.getObject("hospital.Patient", "PT-1001", clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
    expect(ids((await runtime.query({ type: "hospital.Patient" }, clinicianB)).items)).toEqual(["PT-1002"]);
    expect(ids((await runtime.query({ type: "hospital.Patient", filter: { property: "name", operator: "eq", value: "Jordan Lee" } }, clinicianB)).items)).toEqual([]);
    expect(await runtime.getRelationship("hospital.Appointment", "APT-3002", "patient", clinicianB)).toEqual([]);
    const viaProviders = await runtime.query({ type: "hospital.Provider", include: [{ relationship: "patients" }] }, clinicianB);
    expect(viaProviders.items.flatMap((p) => ids(p.values.patients as { objectId: string }[]))).not.toContain("PT-1001");
    await expect(runtime.getProvenance("hospital.Patient", "PT-1001", "medicalRecordNumber", clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.aggregate({ type: "hospital.Patient", aggregations: [{ name: "n", op: "count" }] }, clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
  });

  /**
   * The intended divergences, all in the fail-closed direction: a *declared*
   * attribute whose value isn't the schema's type fails the whole Cedar
   * request (ADR-0031), where the ABAC helper merely fails to match it. So
   * Cedar denies even what that subject could otherwise read, and even an
   * admin reading an object whose stored value is malformed.
   */
  describe("intended divergences: Cedar fails a malformed declared attribute closed", () => {
    async function worlds(extra: { objectId: string; values: Record<string, unknown> }[] = []) {
      const [a, c] = [await buildHospitalTestbed(), await buildHospitalTestbed()];
      for (const tb of [a, c]) tb.adapter.seed("hospital.Patient", extra);
      return { abac: a.runtime, cedar: new SemanticRuntime(c.registry, [c.adapter], cedarEngine(), CLASSIFIED) };
    }

    it("an identity whose declared claim has the wrong type is refused everything under Cedar", async () => {
      const { abac, cedar } = await worlds();
      for (const providerId of [["PR-2001"], { __entity: { type: "TypeS::User", id: "PR-2001" } }, 2001]) {
        const malformed = identity("c-malformed", ["clinician"], { providerId });
        await expect(abac.getObject("hospital.Patient", "PT-1001", malformed)).rejects.toBeInstanceOf(AuthorizationError);
        await expect(cedar.getObject("hospital.Patient", "PT-1001", malformed)).rejects.toBeInstanceOf(AuthorizationError);
        // Role-level reads: ABAC allows them; Cedar can't reason about the subject at all.
        expect((await abac.query({ type: "hospital.Appointment" }, malformed)).items).toHaveLength(3);
        // Its plan is `never`, so the query is refused (ADR-0049) rather than answered with an empty page.
        await expect(cedar.query({ type: "hospital.Appointment" }, malformed)).rejects.toBeInstanceOf(AuthorizationError);
        await expect(cedar.getObject("hospital.Provider", "PR-2001", malformed)).rejects.toBeInstanceOf(AuthorizationError);
      }
    });

    it("a stored value of the wrong type makes its object unreadable under Cedar, even to an admin", async () => {
      const numeric = { objectId: "PT-1006", values: { id: "PT-1006", name: "Numeric", medicalRecordNumber: "MRN-1006", assignedClinicianId: 2002 } };
      const { abac, cedar } = await worlds([numeric]);
      const numericClinician = identity("c-numeric", ["clinician"], { providerId: 2002 });
      const admin = IDENTITIES.admin!;

      await expect(abac.getObject("hospital.Patient", "PT-1006", numericClinician)).resolves.toMatchObject({ objectId: "PT-1006" });
      await expect(abac.getObject("hospital.Patient", "PT-1006", admin)).resolves.toMatchObject({ objectId: "PT-1006" });
      await expect(cedar.getObject("hospital.Patient", "PT-1006", numericClinician)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(cedar.getObject("hospital.Patient", "PT-1006", admin)).rejects.toBeInstanceOf(AuthorizationError);
      expect(ids((await cedar.query({ type: "hospital.Patient" }, admin)).items)).not.toContain("PT-1006");
    });
  });
});
