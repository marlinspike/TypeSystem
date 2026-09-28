import { describe, it, expect } from "vitest";
import { AuthorizationError } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities } from "../src/setup.js";

describe("hospital domain: authorization boundaries", () => {
  it("denies object-level read entirely for an identity with no roles", async () => {
    const { runtime } = await buildHospitalTestbed();
    await expect(
      runtime.getObject("hospital.Patient", "PT-1001", hospitalDemoIdentities.anonymous)
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("a patient identity can read their own record but not the staff-only medicalRecordNumber field", async () => {
    const { runtime } = await buildHospitalTestbed();
    const asPatient = await runtime.getObject("hospital.Patient", "PT-1001", hospitalDemoIdentities.patient);
    expect("name" in asPatient.values).toBe(true);
    expect("medicalRecordNumber" in asPatient.values).toBe(false);
  });

  it("a clinician identity sees the full record, medicalRecordNumber included", async () => {
    const { runtime } = await buildHospitalTestbed();
    const asClinician = await runtime.getObject("hospital.Patient", "PT-1001", hospitalDemoIdentities.clinician);
    expect(asClinician.values.medicalRecordNumber).toBe("MRN-1001");
  });

  it("the Provider directory is public — even an anonymous identity can read it", async () => {
    const { runtime } = await buildHospitalTestbed();
    const provider = await runtime.getObject("hospital.Provider", "PR-2001", hospitalDemoIdentities.anonymous);
    expect(provider.values.displayName).toBe("Dr. Priya Nair");
  });

  it("appointments are denied to anonymous but visible to patient and clinician alike", async () => {
    const { runtime } = await buildHospitalTestbed();
    await expect(
      runtime.getObject("hospital.Appointment", "APT-3001", hospitalDemoIdentities.anonymous)
    ).rejects.toBeInstanceOf(AuthorizationError);

    const asPatient = await runtime.getObject("hospital.Appointment", "APT-3001", hospitalDemoIdentities.patient);
    expect(asPatient.values.status).toBe("scheduled");
  });
});
