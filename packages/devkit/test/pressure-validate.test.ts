/**
 * Adversarial review of validateQuery (ADR-0056): it must not call valid what
 * the runtime refuses.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { describeModel, type ModelDescription, type SemanticQuery } from "@typesys/core";
import { buildAirforceTestbed, type AirforceTestbed } from "@typesys/domain-airforce";
import { validateQuery } from "../src/index.js";

let airforce: AirforceTestbed;
let model: ModelDescription;
beforeAll(async () => {
  airforce = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  model = await describeModel(airforce.registry, { prefixes: ["airforce."] });
});

describe("pressure: validateQuery and Object.prototype names", () => {
  const queries: SemanticQuery[] = [
    { type: "airforce.Aircraft", filter: { property: "constructor", operator: "eq", value: 1 } },
    { type: "airforce.Aircraft", select: ["toString"] },
    { type: "airforce.Aircraft", sort: [{ property: "hasOwnProperty" }] }
  ];
  for (const q of queries) {
    it(`reports a value no Type has: ${JSON.stringify(q)}`, () => {
      // Observed runtime (maintainer): filter/sort on these names is refused with AuthorizationError, select is accepted.
      const errors = validateQuery(model, q).filter((d) => d.severity === "error").map((d) => d.code);
      expect(errors).toEqual(["unknown-property"]);
    });
  }
});
