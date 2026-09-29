import { describe, it, expect } from "vitest";
import { parseResolution } from "../src/runtime/resolution.js";

describe("parseResolution (ADR-0028)", () => {
  it("parses the two single-field strategies", () => {
    expect(parseResolution("byForeignKey:aircraftId")).toEqual({ kind: "byForeignKey", field: "aircraftId" });
    expect(parseResolution("byOwnField:providerId")).toEqual({ kind: "byOwnField", field: "providerId" });
  });

  it("parses byJoinTable, with and without a data-source prefix", () => {
    expect(parseResolution("byJoinTable:Assignment/aircraftId/crewId")).toEqual({
      kind: "byJoinTable",
      joinType: "Assignment",
      sourceKey: "aircraftId",
      targetKey: "crewId",
      dataSourceId: undefined
    });
    expect(parseResolution("byJoinTable:crewdb@Assignment/aircraftId/crewId")).toEqual({
      kind: "byJoinTable",
      joinType: "Assignment",
      sourceKey: "aircraftId",
      targetKey: "crewId",
      dataSourceId: "crewdb"
    });
  });

  it("parses byCompositeKey with one or more field pairs", () => {
    expect(parseResolution("byCompositeKey:homeBase=homeBase")).toEqual({
      kind: "byCompositeKey",
      keys: [{ targetField: "homeBase", sourceField: "homeBase" }]
    });
    expect(parseResolution("byCompositeKey:homeBase=base,squadron=unit")).toEqual({
      kind: "byCompositeKey",
      keys: [
        { targetField: "homeBase", sourceField: "base" },
        { targetField: "squadron", sourceField: "unit" }
      ]
    });
  });

  it("throws on malformed operations", () => {
    expect(() => parseResolution("byForeignKey:")).toThrow();
    expect(() => parseResolution("byJoinTable:Assignment/onlyOne")).toThrow();
    expect(() => parseResolution("byCompositeKey:noEquals")).toThrow();
    expect(() => parseResolution("nonsense:x")).toThrow();
  });
});
