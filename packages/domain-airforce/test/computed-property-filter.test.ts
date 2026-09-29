import { describe, it, expect } from "vitest";
import { InvalidInputError } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities } from "../src/setup.js";

// `needsAttention` and `readinessStatus` are computed (ADR-0022): they don't exist in the adapter,
// which is where a top-level filter runs, so a filter on them used to silently match nothing.
describe("Top-level filters on computed properties", () => {
  it.each([
    ["needsAttention", true],
    ["readinessStatus", "PMC"]
  ])("rejects a filter on %s instead of silently returning nothing", async (property, value) => {
    const { runtime } = await buildAirforceTestbed();
    const query = runtime.query({ type: "airforce.Aircraft", filter: { property, operator: "eq", value } }, demoIdentities.maintainer);
    await expect(query).rejects.toBeInstanceOf(InvalidInputError);
    await expect(query).rejects.toThrow(/computed property "[a-zA-Z]+"/);
  });

  it("names every computed property in the filter, including inside and/or", async () => {
    const { runtime } = await buildAirforceTestbed();
    await expect(
      runtime.query(
        {
          type: "airforce.Aircraft",
          filter: {
            and: [
              { property: "tailNumber", operator: "ne", value: "X" },
              { or: [{ property: "needsAttention", operator: "eq", value: true }, { property: "readinessStatus", operator: "eq", value: "PMC" }] }
            ]
          }
        },
        demoIdentities.maintainer
      )
    ).rejects.toThrow(/computed properties "needsAttention", "readinessStatus"|computed properties "readinessStatus", "needsAttention"/);
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
