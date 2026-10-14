import { describe, expect, it } from "vitest";
import { findViolations, isChecked } from "../terminology.js";

const retired = ["Type", "S"].join("");

describe("the terminology check (ADR-0064)", () => {
  it("finds the retired name alone, possessive, in identifiers, headers and Cedar namespaces", () => {
    const text = [`${retired} is great`, `${retired}'s tools`, `create${retired}Hooks()`, `X-${retired}-Stats`, `${retired}::User`, `(_${retired}_)`].join("\n");
    expect(findViolations("a.md", text).map((v) => v.line)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("passes TypeSystem, TypeSys, TypeScript, Types and typesys identifiers", () => {
    expect(findViolations("a.ts", "TypeSystem, TypeSys, TypeScript, Types, @typesys/core, typesys_get_object, TypeSysProvider")).toEqual([]);
  });

  it("skips a line that carries the allow marker, and nothing else", () => {
    const text = `old name ${retired} // terminology-allow: migration note\n${retired} again`;
    expect(findViolations("a.ts", text)).toEqual([{ file: "a.ts", line: 2, column: 1, text: `${retired} again` }]);
  });

  it("does not read lockfiles or binary formats", () => {
    expect(isChecked("package-lock.json")).toBe(false);
    expect(isChecked("packages/x/logo.png")).toBe(false);
    expect(isChecked("docs/adr/0064-the-product-is-typesystem.md")).toBe(true);
  });
});
