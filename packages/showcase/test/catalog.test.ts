import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COVERAGE, QUESTIONS, ROOT, STAGES, SURFACES, coverageMarkdown } from "../src/index.js";

/** Every source file of the servers whose tools the catalog names. Tool names are written whole or as the reserved prefix plus the rest. */
const toolSources = ["packages/mcp-server/src", "packages/compiler/src", "packages/onboard/src"]
  .flatMap((dir) => readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(path.join(ROOT, dir, f), "utf8")))
  .join("\n");

describe("the showcase catalog", () => {
  it("asks the ten questions, each answered on a surface, from a terminal and over MCP", () => {
    expect(QUESTIONS.map((q) => q.id)).toEqual(["systems", "objects", "relationships", "identity", "provenance", "consumers", "workflow", "failure", "evolve", "regressions"]);
    for (const q of QUESTIONS) {
      expect(q.links.length, q.id).toBeGreaterThan(0);
      expect(q.cli.length, q.id).toBeGreaterThan(0);
      expect(q.mcp.length, q.id).toBeGreaterThan(0);
      for (const l of q.links) {
        expect(SURFACES[l.surface], `${q.id} ${l.surface}`).toBeDefined();
        expect(l.path.startsWith("/"), `${q.id} ${l.path}`).toBe(true);
      }
    }
  });

  it("names only files that exist", () => {
    const named = [...QUESTIONS.flatMap((q) => q.sources), ...STAGES.map((s) => s.evidence)];
    expect(named.filter((f) => !existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  it("names only MCP tools a server registers", () => {
    const tools = [...new Set(QUESTIONS.flatMap((q) => q.mcp.flatMap((m) => m.tools)))];
    const missing = tools.filter((t) => {
      const rest = t.replace(/^typesys_/, "");
      return !new RegExp(`(typesys_|\\{p\\}|PREFIX\\})${rest}\\b`).test(toolSources);
    });
    expect(missing).toEqual([]);
  });

  it("walks stages A to F, and every capability row answers a question", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    const ids = new Set(QUESTIONS.map((q) => q.id));
    for (const c of COVERAGE) if (c.question) expect(ids.has(c.question), c.feature).toBe(true);
  });

  it("matches docs/showcase/coverage.md (regenerate with `npm run showcase -- coverage --write`)", () => {
    expect(readFileSync(path.join(ROOT, "docs/showcase/coverage.md"), "utf8")).toBe(coverageMarkdown());
  });
});
