import { describe, it, expect } from "vitest";
import { assertContract, contractMismatches, ContractUnsatisfiedError, currentContract, formatContractHeader, parseContractHeader, runUnderContract, validateContract } from "../src/runtime/contract.js";
import { InvalidInputError } from "../src/runtime/errors.js";

/** ADR-0103: the contract a consumer declares, carried per request, checked fail-closed. */
describe("consumer contracts", () => {
  it("round-trips through the TypeSystem-Contract header, ranges with spaces included", () => {
    const contract = { "airforce.WorkOrder": ">=1.2.0 <2.0.0", "airforce.Aircraft": "^1.0.0" };
    const header = formatContractHeader(contract);
    expect(header).toBe("airforce.Aircraft@^1.0.0, airforce.WorkOrder@>=1.2.0 <2.0.0");
    expect(parseContractHeader(header)).toEqual(contract);
    expect(parseContractHeader(["airforce.Aircraft@^1.0.0", "airforce.WorkOrder@1.x"])).toEqual({ "airforce.Aircraft": "^1.0.0", "airforce.WorkOrder": "1.x" });
    expect(parseContractHeader(undefined)).toBeUndefined();
    expect(parseContractHeader("  ")).toBeUndefined();
  });

  it("refuses a header that is not one, naming every problem", () => {
    const bad = (h: string) => {
      try {
        parseContractHeader(h);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidInputError);
        return (err as Error).message;
      }
      throw new Error("parsed");
    };
    expect(bad("airforce.Aircraft")).toContain("is not Type@range");
    expect(bad("Aircraft@^1.0.0")).toContain("not a qualified Type name");
    expect(bad("airforce.Aircraft@banana")).toContain("must be a semver range");
    expect(bad("a.B@1.x, a.B@2.x")).toContain("named twice");
    expect(bad("__proto__.x@1.x, constructor@1.x")).toContain('"constructor" is not a qualified Type name');
    expect(bad("__proto__@1.x")).toContain('"__proto__" is not a qualified Type name');
    expect(() => parseContractHeader(`a.B@${"1".repeat(20_000)}`)).toThrow("too long");
  });

  it("validates a contract given as data", () => {
    expect(validateContract({ "a.B": "^1.0.0" })).toEqual([]);
    expect(validateContract([])).toEqual(["contract: must map Type names to semver ranges"]);
    expect(validateContract({ "a.B": 1 }).join()).toContain("semver range");
  });

  it("reports which Types fall outside, and which are missing", () => {
    expect(contractMismatches({ "a.A": "^1.0.0", "a.B": "^2.0.0", "a.C": "1.x" }, { "a.A": "1.4.0", "a.B": "1.9.0" })).toEqual([
      { type: "a.B", range: "^2.0.0", version: "1.9.0" },
      { type: "a.C", range: "1.x" }
    ]);
    expect(contractMismatches({ "a.A": "^1.0.0" }, new Map([["a.A", "1.0.0"]]))).toEqual([]);
  });

  it("is in force for the call it wraps and everything that call awaits, and nowhere else", async () => {
    expect(currentContract()).toBeUndefined();
    await runUnderContract({ "a.A": "^1.0.0" }, async () => {
      await Promise.resolve();
      expect(currentContract()).toEqual({ "a.A": "^1.0.0" });
      expect(() => assertContract({ name: "a.A", version: "2.0.0" })).toThrow(ContractUnsatisfiedError);
      expect(() => assertContract({ name: "a.A", version: "1.3.0" })).not.toThrow();
      expect(() => assertContract({ name: "a.Z", version: "9.0.0" })).not.toThrow();
    });
    expect(currentContract()).toBeUndefined();
    expect(() => assertContract({ name: "a.A", version: "2.0.0" })).not.toThrow();
    expect(runUnderContract(undefined, () => 7)).toBe(7);
  });
});
