import { describe, it, expect } from "vitest";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

// `needsAttention` and `readinessStatus` are computed (ADR-0022): they don't exist in the adapter. A top-level
// filter on them used to be refused (it would have matched nothing there); since ADR-0054 that part of the
// filter runs in the runtime, on each object's finalized, caller-visible values.
describe("Top-level filters on computed properties (ADR-0054)", () => {
  it.each([
    ["needsAttention", true, ["AF86-0147"]],
    ["readinessStatus", "PMC", ["AF86-0147"]],
    ["readinessStatus", "FMC", ["AF86-0212"]]
  ])("filters on %s = %s", async (property, value, expected) => {
    const { runtime } = await buildAirforceTestbed();
    const page = await runtime.query({ type: "airforce.Aircraft", filter: { property, operator: "eq", value } }, demoIdentities.maintainer);
    expect(page.items.map((i) => i.objectId).sort()).toEqual(expected);
  });

  it("combines a stored condition, pushed to the adapter, with a computed one inside and/or", async () => {
    const { runtime } = await buildAirforceTestbed();
    const page = await runtime.query(
      {
        type: "airforce.Aircraft",
        filter: {
          and: [
            { property: "tailNumber", operator: "ne", value: "X" },
            { or: [{ property: "needsAttention", operator: "eq", value: true }, { property: "readinessStatus", operator: "eq", value: "NMC" }] }
          ]
        }
      },
      demoIdentities.maintainer
    );
    expect(page.items.map((i) => i.objectId)).toEqual(["AF86-0147"]);
  });

  it("can't probe a value withheld from the caller: readinessStatus matches nothing for the viewer, whatever it is", async () => {
    const { runtime } = await buildAirforceTestbed();
    for (const value of ["PMC", "FMC", "NMC", "UNKNOWN"]) {
      const page = await runtime.query({ type: "airforce.Aircraft", filter: { property: "readinessStatus", operator: "eq", value } }, demoIdentities.viewer);
      expect(page.items).toEqual([]);
    }
    // needsAttention is released to the viewer (ADR-0052), so it filters for them too.
    const released = await runtime.query({ type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true } }, demoIdentities.viewer);
    expect(released.items.map((i) => i.objectId)).toEqual(["AF86-0147"]);
  });

  it("still returns computed values in results when filtering on stored properties", async () => {
    const { runtime } = await buildAirforceTestbed();
    const result = await runtime.query(
      { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" } },
      demoIdentities.maintainer
    );
    expect(result.items[0]!.values.needsAttention).toBe(true);
  });
});
