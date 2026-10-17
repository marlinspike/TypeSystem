import { describe, expect, it } from "vitest";
import { requireRole } from "@typesys/core";
import { buildHospitalTestbed, hospitalDemoIdentities } from "@typesys/domain-hospital";
import { probeLinks, renderLinks } from "../src/index.js";

/**
 * Probing links (ADR-0094): each relationship explained on a few objects,
 * through the runtime. A reference to an object no source holds is
 * counted, but only for an inspector explaining someone else: telling a
 * caller would name what their own read leaves out.
 */
const admin = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };

async function hospital() {
  const tb = await buildHospitalTestbed({ runtimeOptions: { inspection: { policy: "hospital.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("hospital.inspect", requireRole("admin"));
  // An appointment booked for a patient the record system does not hold.
  tb.adapter.seed("hospital.Appointment", [{ objectId: "APT-0404", values: { id: "APT-0404", patientId: "PT-0404", providerId: "PR-2001", scheduledAt: "2026-10-20T09:00:00.000Z", status: "scheduled" } }]);
  return tb;
}

describe("probing links", () => {
  it("counts a dangling reference for an inspector explaining a caller, and never for the caller themselves", async () => {
    const { runtime } = await hospital();
    const forClinician = await probeLinks(runtime, admin, { as: hospitalDemoIdentities.clinician, types: ["hospital.Appointment"], sample: 10 });
    const patient = forClinician.relationships.find((r) => r.relationship === "patient")!;
    expect(forClinician.disclosure).toBe("inspector");
    expect(patient.dangling).toBe(1);
    expect(patient.examples).toContainEqual(expect.objectContaining({ object: "hospital.Patient/PT-0404", outcome: "dangling" }));
    // The clinician reads only their assigned patients: the rest are refused to them, which the inspector is told.
    expect(patient.refused).toBeGreaterThan(0);
    const own = await probeLinks(runtime, hospitalDemoIdentities.clinician, { types: ["hospital.Appointment"], sample: 10 });
    const ownPatient = own.relationships.find((r) => r.relationship === "patient")!;
    expect([own.disclosure, ownPatient.dangling, ownPatient.refused]).toEqual(["caller", undefined, undefined]);
    expect(JSON.stringify(own)).not.toContain("PT-0404");
    expect(renderLinks(own)).toContain("Dangling and refused references are counted only when an inspector explains another caller's access (--for).");
  });

  it("refuses explaining someone else to a caller who may not inspect, as the runtime does", async () => {
    const { runtime } = await hospital();
    const p = await probeLinks(runtime, hospitalDemoIdentities.clinician, { as: hospitalDemoIdentities.patient, types: ["hospital.Appointment"] });
    expect(p.relationships.every((r) => r.probed === 0 && r.examples.every((e) => e.outcome === "refused"))).toBe(true);
  });
});
