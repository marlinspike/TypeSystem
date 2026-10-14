import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { applyMutation, catalogHash, catalogProblems, classify, passed, summarize, type Catalog, type Mutation } from "../mutation.js";

/** The mutation harness's own rules (ADR-0070), and the committed catalog against the code it names. */
const committed = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8")) as Catalog;
const root = new URL("../../../", import.meta.url);

const one: Mutation = { id: "x.y", adr: "0001", description: "d", file: "a.ts", find: "a", replace: "b", tests: ["t.test.ts"] };

describe("the mutation catalog (ADR-0070)", () => {
  it("is well formed, and every mutation applies to exactly the code it names", () => {
    expect(catalogProblems(committed)).toEqual([]);
    const stale = committed.mutations.flatMap((m) => {
      const applied = applyMutation(readFileSync(new URL(m.file, root), "utf8"), m);
      return "stale" in applied ? [`${m.id}: ${applied.stale}`] : [];
    });
    expect(stale).toEqual([]);
  });

  it("names only test files that exist, and covers every ADR of M2", () => {
    for (const m of committed.mutations) for (const t of m.tests) expect(() => readFileSync(new URL(t, root)), `${m.id}: ${t}`).not.toThrow();
    for (const adr of ["0064", "0065", "0066", "0067", "0068", "0069"]) expect(committed.mutations.some((m) => m.adr === adr), adr).toBe(true);
  });

  it("refuses a malformed catalog with every problem at once", () => {
    expect(catalogProblems({ format: "other" })).toEqual(["format is not typesys.mutation-catalog/1"]);
    const problems = catalogProblems({
      format: "typesys.mutation-catalog/1",
      mutations: [one, { ...one, file: "../etc/passwd", tests: ["/abs.test.ts"], replace: "a", adr: "1", id: "Bad Id" }, one, { ...one, id: "z.w", equivalent: " " }]
    });
    expect(problems).toEqual([
      "mutations[1] (Bad Id): id must be <mechanism>.<what-breaks> in kebab-case",
      "mutations[1] (Bad Id): adr must be four digits",
      "mutations[1] (Bad Id): file must be a repository-relative path",
      "mutations[1] (Bad Id): replace is the same as find",
      "mutations[1] (Bad Id): tests must list repository-relative test files",
      "mutations[2] (x.y): duplicate id",
      "mutations[3] (z.w): equivalent must give a reason"
    ]);
  });
});

describe("applying a mutation", () => {
  it("replaces the one occurrence, or the one asked for", () => {
    expect(applyMutation("let a = 1;", { find: "1", replace: "2" })).toEqual({ mutated: "let a = 2;" });
    expect(applyMutation("x x x", { find: "x", replace: "y", occurrence: 2 })).toEqual({ mutated: "x y x" });
  });

  it("goes stale, never guesses, when the code moved", () => {
    expect(applyMutation("abc", { find: "z", replace: "y" })).toEqual({ stale: "the text to replace is not in the file" });
    expect(applyMutation("x x", { find: "x", replace: "y" })).toEqual({ stale: "the text to replace occurs 2 times; say which with occurrence" });
    expect(applyMutation("x x", { find: "x", replace: "y", occurrence: 3 })).toEqual({ stale: "occurrence 3 asked for, 2 found" });
  });
});

describe("what a run concludes", () => {
  it("classifies each outcome", () => {
    expect(classify({}, { compiled: false, testsFailed: false })).toBe("killed-by-compiler");
    expect(classify({}, { compiled: true, testsFailed: true })).toBe("killed");
    expect(classify({}, { compiled: true, testsFailed: false })).toBe("survived");
    expect(classify({ equivalent: "why" }, { compiled: true, testsFailed: false })).toBe("equivalent");
    // A run that ended without a verdict is not a kill (P3-M4).
    expect(classify({}, { compiled: true, testsFailed: true, inconclusive: true })).toBe("inconclusive");
  });

  it("passes only when nothing survived, went stale, or was left unrun", () => {
    const s = summarize([{ status: "killed" }, { status: "equivalent" }, { status: "killed-by-compiler" }]);
    expect(passed(s)).toBe(true);
    expect(passed(summarize([{ status: "killed" }, { status: "survived" }]))).toBe(false);
    expect(passed(summarize([{ status: "stale" }]))).toBe(false);
    expect(passed(summarize([{ status: "inconclusive" }]))).toBe(false);
    expect(passed(summarize([{ status: "not-run" }]))).toBe(false);
    expect(passed(summarize([{ status: "not-run" }]), { allowNotRun: true })).toBe(true);
  });

  it("names the catalog by the hash of its bytes", () => {
    expect(catalogHash("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
