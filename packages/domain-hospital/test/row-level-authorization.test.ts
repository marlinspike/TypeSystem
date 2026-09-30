import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthorizationError, type Identity, type SemanticRuntime } from "@typesys/core";
import { registerResourceHandlers, registerToolHandlers, type IdentityResolver } from "@typesys/mcp-server";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

/**
 * The hospital demo of ADR-0030: `hospital.read-patient` is decided on each
 * Patient's own `assignedClinicianId`. Clinician A (`clinician`, Provider
 * PR-2001) is assigned PT-1001; clinician B (`otherClinician`, PR-2002) is
 * assigned PT-1002. Every attack below is B trying to read A's patient.
 */
const { clinician: clinicianA, otherClinician: clinicianB, patient, anonymous } = hospitalDemoIdentities;
const admin: Identity = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };

/** Every stored value of A's patient, PT-1001. None may reach clinician B — in data, errors, reasons, or audit rows. */
const PT_1001_PHI = ["Jordan Lee", "MRN-1001", "1985-03-14"];

type Obj = { objectId: string; values: Record<string, unknown> };
const ids = (objs: unknown) => (objs as Obj[]).map((o) => o.objectId).sort();

async function patientIdsReachableBy(runtime: SemanticRuntime, identity: Identity): Promise<string[]> {
  const reached = new Set<string>();
  const collect = (objs: unknown) => {
    for (const o of objs as Obj[]) {
      if (o.objectId.startsWith("PT-")) reached.add(o.objectId);
      for (const v of Object.values(o.values)) if (Array.isArray(v)) collect(v);
    }
  };
  collect((await runtime.query({ type: "hospital.Patient" }, identity)).items);
  collect((await runtime.query({ type: "hospital.Appointment", include: [{ relationship: "patient" }] }, identity)).items);
  collect((await runtime.query({ type: "hospital.Provider", include: [{ relationship: "patients" }] }, identity)).items);
  collect(
    (await runtime.query({ type: "hospital.Provider", include: [{ relationship: "appointments", include: [{ relationship: "patient" }] }] }, identity)).items
  );
  return [...reached].sort();
}

describe("hospital domain: per-instance Patient authorization (ADR-0030)", () => {
  it("a clinician reads exactly the patients assigned to them", async () => {
    const { runtime } = await buildHospitalTestbed();
    expect((await runtime.getObject("hospital.Patient", "PT-1001", clinicianA)).values.medicalRecordNumber).toBe("MRN-1001");
    expect((await runtime.getObject("hospital.Patient", "PT-1002", clinicianB)).values.medicalRecordNumber).toBe("MRN-1002");
    expect(ids((await runtime.query({ type: "hospital.Patient" }, clinicianA)).items)).toEqual(["PT-1001"]);
    expect(ids((await runtime.query({ type: "hospital.Patient" }, clinicianB)).items)).toEqual(["PT-1002"]);
  });

  it("a patient reads only their own record, still without the staff-only MRN", async () => {
    const { runtime } = await buildHospitalTestbed();
    const own = await runtime.getObject("hospital.Patient", "PT-1001", patient);
    expect(own.values.name).toBe("Jordan Lee");
    expect(own.values).not.toHaveProperty("medicalRecordNumber");
    await expect(runtime.getObject("hospital.Patient", "PT-1002", patient)).rejects.toBeInstanceOf(AuthorizationError);
    expect(ids((await runtime.query({ type: "hospital.Patient" }, patient)).items)).toEqual(["PT-1001"]);
  });

  it("an admin reads every record, and — the rule allowing unconditionally — may aggregate over them", async () => {
    const { runtime } = await buildHospitalTestbed();
    expect(ids((await runtime.query({ type: "hospital.Patient" }, admin)).items)).toEqual(["PT-1001", "PT-1002"]);
    const byClinician = await runtime.aggregate(
      { type: "hospital.Patient", groupBy: ["assignedClinicianId"], aggregations: [{ name: "patients", op: "count" }] },
      admin
    );
    expect(byClinician.groups).toHaveLength(2);
  });

  it("each clinician reaches only their own patients through every include path", async () => {
    const { runtime } = await buildHospitalTestbed();
    expect(await patientIdsReachableBy(runtime, clinicianA)).toEqual(["PT-1001"]);
    expect(await patientIdsReachableBy(runtime, clinicianB)).toEqual(["PT-1002"]);
    expect(await patientIdsReachableBy(runtime, anonymous)).toEqual([]);
  });

  it("role-level Types are unaffected: every clinician sees every appointment, and providers stay public", async () => {
    const { runtime } = await buildHospitalTestbed();
    expect(ids((await runtime.query({ type: "hospital.Appointment" }, clinicianB)).items)).toEqual(["APT-3001", "APT-3002", "APT-3003"]);
    expect(ids((await runtime.query({ type: "hospital.Provider" }, anonymous)).items)).toEqual(["PR-2001", "PR-2002"]);
  });
});

describe("attack: clinician B reading clinician A's patient (PT-1001)", () => {
  it("cannot via getObject", async () => {
    const { runtime } = await buildHospitalTestbed();
    await expect(runtime.getObject("hospital.Patient", "PT-1001", clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("cannot via a query — plain, filtered, searched, sorted, or paged", async () => {
    const { runtime } = await buildHospitalTestbed();
    const queries = [
      { type: "hospital.Patient" },
      { type: "hospital.Patient", filter: { property: "id", operator: "eq" as const, value: "PT-1001" } },
      { type: "hospital.Patient", filter: { property: "name", operator: "eq" as const, value: "Jordan Lee" } },
      { type: "hospital.Patient", filter: { property: "assignedClinicianId", operator: "eq" as const, value: "PR-2001" } },
      { type: "hospital.Patient", filter: { property: "medicalRecordNumber", operator: "eq" as const, value: "MRN-1001" } },
      { type: "hospital.Patient", search: { text: "jordan" } },
      { type: "hospital.Patient", sort: [{ property: "name", direction: "asc" as const }] }
    ];
    for (const q of queries) {
      expect(ids((await runtime.query(q, clinicianB)).items)).not.toContain("PT-1001");
    }

    let cursor: string | undefined;
    const paged: string[] = [];
    do {
      const page = await runtime.query({ type: "hospital.Patient", limit: 1, ...(cursor ? { cursor } : {}) }, clinicianB);
      paged.push(...ids(page.items));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(["PT-1002"]);
  });

  it("cannot via a relationship include: Appointment.patient, Provider.patients (many-to-many), or a nested include", async () => {
    const { runtime } = await buildHospitalTestbed();
    // APT-3002 is B's own appointment with PT-1001, and Provider.patients joins through it — B still gets nothing.
    expect(await runtime.getRelationship("hospital.Appointment", "APT-3002", "patient", clinicianB)).toEqual([]);
    expect(await runtime.getRelationship("hospital.Provider", "PR-2002", "patients", clinicianB)).toEqual([]);
    // Symmetrically, A's join reaches both patients A has seen, but A reads only the one assigned to A.
    expect(ids(await runtime.getRelationship("hospital.Provider", "PR-2001", "patients", clinicianA))).toEqual(["PT-1001"]);
    expect(await patientIdsReachableBy(runtime, clinicianB)).not.toContain("PT-1001");
  });

  it("cannot navigate from the patient, or read any of its provenance", async () => {
    const { runtime } = await buildHospitalTestbed();
    await expect(runtime.getRelationship("hospital.Patient", "PT-1001", "appointments", clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(runtime.getRelationship("hospital.Patient", "PT-1001", "providers", clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
    for (const property of ["name", "dateOfBirth", "medicalRecordNumber", "assignedClinicianId"]) {
      await expect(runtime.getProvenance("hospital.Patient", "PT-1001", property, clinicianB)).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("cannot count or group A's patients through aggregation", async () => {
    const { runtime } = await buildHospitalTestbed();
    await expect(
      runtime.aggregate({ type: "hospital.Patient", groupBy: ["assignedClinicianId"], aggregations: [{ name: "n", op: "count" }] }, clinicianB)
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("cannot over MCP, the AI-agent path — the same runtime, the same decision", async () => {
    const { registry, runtime } = await buildHospitalTestbed();
    const resolve: IdentityResolver = async (token) => (token === "a" ? clinicianA : token === "b" ? clinicianB : anonymous);
    const server = new Server({ name: "row-level-test", version: "0.0.0" }, { capabilities: { resources: {}, tools: {} } });
    registerResourceHandlers(server, registry, runtime, resolve);
    registerToolHandlers(server, registry, runtime, resolve);
    const client = new Client({ name: "row-level-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const asA = await client.readResource({ uri: "typesys://objects/hospital.Patient/PT-1001?token=a" });
    expect((asA.contents[0] as { text: string }).text).toContain("MRN-1001"); // the positive control: A's own patient
    await expect(client.readResource({ uri: "typesys://objects/hospital.Patient/PT-1001?token=b" })).rejects.toThrow(/Not authorized/);
    const listed = await client.callTool({ name: "query", arguments: { type: "hospital.Patient", authToken: "b" } });
    const text = (listed.content as { text: string }[])[0]!.text;
    expect(ids((JSON.parse(text) as { items: Obj[] }).items)).toEqual(["PT-1002"]);
    for (const phi of PT_1001_PHI) expect(text).not.toContain(phi);
    await client.close();
  });

  it("every attempt is audited as a deny against PT-1001, and no PHI reaches an error, a reason, or the audit log", async () => {
    const { registry, runtime } = await buildHospitalTestbed();
    const errors: unknown[] = [];
    const capture = (p: Promise<unknown>) => p.catch((e: unknown) => void errors.push(e));

    await capture(runtime.getObject("hospital.Patient", "PT-1001", clinicianB));
    await capture(runtime.getRelationship("hospital.Patient", "PT-1001", "appointments", clinicianB));
    await capture(runtime.getProvenance("hospital.Patient", "PT-1001", "medicalRecordNumber", clinicianB));
    await runtime.query({ type: "hospital.Patient" }, clinicianB);
    await runtime.getRelationship("hospital.Appointment", "APT-3002", "patient", clinicianB);

    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e).toBeInstanceOf(AuthorizationError);

    const audit = (await registry.listAuditEvents({ limit: 1000 })).items;
    const denials = audit.filter((e) => e.subjectId === clinicianB.subjectId && e.resource.objectId === "PT-1001" && e.decision === "deny");
    expect(denials).toHaveLength(5);
    expect(audit.some((e) => e.subjectId === clinicianB.subjectId && e.resource.objectId === "PT-1001" && e.decision === "allow")).toBe(false);

    const surfaced = JSON.stringify({ audit, errors: (errors as AuthorizationError[]).map((e) => [e.message, e.reason]) });
    for (const phi of PT_1001_PHI) expect(surfaced).not.toContain(phi);
  });

  it("a clinician with no providerId never matches a patient with no assigned clinician", async () => {
    const { runtime, adapter } = await buildHospitalTestbed();
    adapter.seed("hospital.Patient", [{ objectId: "PT-1003", values: { id: "PT-1003", name: "Unassigned", medicalRecordNumber: "MRN-1003" } }]);
    const unlinked: Identity = { subjectId: "user-clinician-3", roles: ["clinician"], attributes: {} };

    await expect(runtime.getObject("hospital.Patient", "PT-1003", unlinked)).rejects.toBeInstanceOf(AuthorizationError);
    expect((await runtime.query({ type: "hospital.Patient" }, unlinked)).items).toEqual([]);
    expect(ids((await runtime.query({ type: "hospital.Patient" }, admin)).items)).toContain("PT-1003");
  });

  it("the patient role cannot reach another patient's record either", async () => {
    const { runtime } = await buildHospitalTestbed();
    expect(await patientIdsReachableBy(runtime, patient)).toEqual(["PT-1001"]);
  });
});
