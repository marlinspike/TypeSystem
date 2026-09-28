import { describe, it, expect } from "vitest";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

describe("hospital domain: registration and composition (ADR-0013 domain-neutrality)", () => {
  it("Patient is correctly composed with core.Person (and, transitively, core.Party)", async () => {
    const { registry } = await buildHospitalTestbed();
    const patientType = await registry.getType("hospital.Patient");
    expect(patientType?.extends).toBe("core.Person");
    // core.Person's own schema is referenced, not flattened/redeclared, via allOf ($ref)...
    expect(patientType?.schema.allOf?.length ?? 0).toBeGreaterThan(0);
    // ...but its relationships ARE materialized into this flattened TypeDefinition.
    expect(patientType?.relationships.map((r) => r.name)).toContain("affiliations");
  });

  it("Appointment's patient/provider relationships are first-class RelationshipDefinitions", async () => {
    const { registry } = await buildHospitalTestbed();
    const appointmentType = await registry.getType("hospital.Appointment");
    const names = appointmentType?.relationships.map((r) => r.name).sort();
    expect(names).toEqual(["patient", "provider"]);
  });
});

describe("hospital domain: relationship resolution, both adapter conventions", () => {
  it("byForeignKey: Patient.appointments resolves every Appointment whose patientId matches", async () => {
    const { runtime } = await buildHospitalTestbed();
    const appointments = await runtime.getRelationship("hospital.Patient", "PT-1001", "appointments", hospitalDemoIdentities.clinician);
    expect(appointments.map((a) => a.objectId).sort()).toEqual(["APT-3001", "APT-3002"]);
  });

  it("byForeignKey: Provider.appointments resolves every Appointment whose providerId matches", async () => {
    const { runtime } = await buildHospitalTestbed();
    const appointments = await runtime.getRelationship("hospital.Provider", "PR-2001", "appointments", hospitalDemoIdentities.clinician);
    expect(appointments.map((a) => a.objectId).sort()).toEqual(["APT-3001", "APT-3003"]);
  });

  it("byOwnField: Appointment.patient resolves the single Patient named by the appointment's own patientId", async () => {
    const { runtime } = await buildHospitalTestbed();
    const related = await runtime.getRelationship("hospital.Appointment", "APT-3001", "patient", hospitalDemoIdentities.clinician);
    expect(related).toHaveLength(1);
    expect(related[0]?.objectId).toBe("PT-1001");
  });

  it("byOwnField: Appointment.provider resolves the single Provider named by the appointment's own providerId", async () => {
    const { runtime } = await buildHospitalTestbed();
    const related = await runtime.getRelationship("hospital.Appointment", "APT-3001", "provider", hospitalDemoIdentities.clinician);
    expect(related).toHaveLength(1);
    expect(related[0]?.objectId).toBe("PR-2001");
  });

  it("a query with include resolves each Appointment's patient and provider concurrently", async () => {
    const { runtime } = await buildHospitalTestbed();
    const result = await runtime.query(
      { type: "hospital.Appointment", include: [{ relationship: "patient" }, { relationship: "provider" }] },
      hospitalDemoIdentities.clinician
    );
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      expect(item.values.patient).toBeDefined();
      expect(item.values.provider).toBeDefined();
    }
  });
});
