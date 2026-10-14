import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { AuthorizationError, ObjectNotFoundError, type Identity, type SemanticRuntime } from "@typesys/core";
import { buildHospitalTestbed, type HospitalTestbed } from "../src/setup.js";
import { samplePatients } from "../src/sample-data/patients.js";
import { sampleProviders } from "../src/sample-data/providers.js";
import { sampleAppointments } from "../src/sample-data/appointments.js";

/**
 * The read path's invariant (ADR-0030, ADR-0038), over generated callers:
 * a query returns exactly the objects a direct read of each would allow, and
 * each with exactly the values that read returns, never one it would refuse.
 * Row-level rules make this domain the hard case: which patients a caller
 * may read depends on their attributes and the patient's.
 */
const TYPES: [string, readonly { objectId: string }[]][] = [
  ["hospital.Patient", samplePatients],
  ["hospital.Provider", sampleProviders],
  ["hospital.Appointment", sampleAppointments]
];

const caller = fc
  .record({
    roles: fc.subarray(["admin", "clinician", "patient", "visitor"]),
    providerId: fc.constantFrom(undefined, "PR-2001", "PR-2002", "PR-9999"),
    patientId: fc.constantFrom(undefined, "PT-1001", "PT-1002")
  })
  .map(({ roles, providerId, patientId }): Identity => ({
    subjectId: "generated",
    roles,
    attributes: { ...(providerId ? { providerId } : {}), ...(patientId ? { patientId } : {}) }
  }));

async function direct(runtime: SemanticRuntime, typeName: string, id: string, who: Identity): Promise<Record<string, unknown> | undefined> {
  try {
    return (await runtime.getObject(typeName, id, who)).values;
  } catch (err) {
    if (err instanceof AuthorizationError || err instanceof ObjectNotFoundError) return undefined;
    throw err;
  }
}

async function queried(runtime: SemanticRuntime, typeName: string, who: Identity): Promise<Map<string, Record<string, unknown>>> {
  try {
    return new Map((await runtime.query({ type: typeName, limit: 100 }, who)).items.map((i) => [i.objectId, i.values]));
  } catch (err) {
    if (err instanceof AuthorizationError) return new Map();
    throw err;
  }
}

describe("a query returns what direct reads would, and nothing they would refuse", () => {
  let tb: HospitalTestbed;
  beforeAll(async () => {
    tb = await buildHospitalTestbed();
  });

  it("property: over generated callers, the objects and values a query returns are exactly those of a direct read of each", async () => {
    await fc.assert(
      fc.asyncProperty(caller, async (who) => {
        for (const [typeName, rows] of TYPES) {
          const fromQuery = await queried(tb.runtime, typeName, who);
          for (const { objectId } of rows) {
            const read = await direct(tb.runtime, typeName, objectId, who);
            expect(fromQuery.get(objectId), `${typeName}/${objectId} for ${JSON.stringify(who)}`).toEqual(read);
          }
          expect([...fromQuery.keys()].every((id) => rows.some((r) => r.objectId === id))).toBe(true);
        }
      }),
      { seed: 20261014, numRuns: 80 }
    );
  });
});
