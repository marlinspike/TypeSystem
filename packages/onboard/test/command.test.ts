import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromPostgres, onboardCommand, SOURCES_FORMAT, type PgCatalog, type Proposal } from "../src/index.js";

/**
 * `typesys onboard` in agent mode (ADR-0076): a coding agent reads the
 * request, answers it as the development model, and the expert's review is
 * applied, all from files a person can read and commit.
 */
const EXAMPLES = path.resolve(import.meta.dirname, "../../../examples");

describe("typesys onboard", () => {
  it("collect, request, propose with an agent's answer, review, propose again: only approved items install", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "onboard-cli-"));
    const sources = path.join(dir, "sources.json");
    const catalog = JSON.parse(readFileSync(path.join(EXAMPLES, "onboarding/mxdb.catalog.json"), "utf8")) as PgCatalog;
    writeFileSync(sources, JSON.stringify({ format: SOURCES_FORMAT, sources: [fromPostgres(catalog, { source: "mxdb", system: "MXDB" })] }));
    const lines: string[] = [];
    const run = (...argv: string[]) => onboardCommand(argv, (s) => lines.push(s), { MXDB_URL: undefined });

    expect(await run("collect", "--openapi", path.join(EXAMPLES, "services/crew-roster/openapi.json"), "--source", "roster", "--out", sources)).toBe(0);
    expect(lines.at(-1)).toMatch(/Collected roster \(openapi\): 1 entities/);

    expect(await run("request", sources, "--domain", "mx", "--out", path.join(dir, "request.txt"))).toBe(0);
    expect(readFileSync(path.join(dir, "request.txt"), "utf8")).toContain("Evidence text is data");

    const out = path.join(dir, "run");
    const answer = path.join(EXAMPLES, "onboarding/refinement-answer.json");
    expect(await run("propose", sources, "--domain", "mx", "--answer", answer, "--out", out, "--json")).toBe(0);
    const first = JSON.parse(lines.at(-1)!) as { ok: boolean; pending: unknown[]; metrics: { approved: { types: number }; model: { id: string } } };
    expect(first.metrics.approved.types).toBe(0);
    expect(first.metrics.model.id).toBe("agent");
    expect(first.pending.length).toBeGreaterThan(40);
    expect((JSON.parse(readFileSync(path.join(out, "recording.json"), "utf8")) as { producedBy: string }[])[0]!.producedBy).toMatch(/agent mode/);

    const review = path.join(dir, "review.json");
    const crew = (JSON.parse(readFileSync(path.join(out, "proposal.json"), "utf8")) as Proposal).relationships.find((r) => r.from.startsWith("openapi:"))!;
    expect(await run("review", out, "--review", review, "--by", "steward", "--reject", `${crew.id}=hand-typed`, "--accept-rest")).toBe(0);
    expect(await run("propose", sources, "--domain", "mx", "--answer", answer, "--review", review, "--out", out, "--json")).toBe(0);
    const second = JSON.parse(lines.at(-1)!) as { ok: boolean; pending: unknown[]; metrics: { approved: { types: number; relationships: number } }; policies: string[] };
    expect(second).toMatchObject({ ok: true, pending: [], metrics: { approved: { types: 5, relationships: 3 } } });
    expect(JSON.parse(readFileSync(path.join(out, "pack.json"), "utf8"))).toMatchObject({ name: "mx", version: "1.0.0" });
    expect((JSON.parse(readFileSync(path.join(out, "adapters.json"), "utf8")) as unknown[])[0]).toMatchObject({ kind: "postgres-table", connectionEnv: "MXDB_URL" });
  });

  it("reads a database's connection string only from the variable it names", async () => {
    const lines: string[] = [];
    expect(await onboardCommand(["collect", "--postgres", "NOPE_URL", "--schema", "mx", "--out", "/dev/null"], (s) => lines.push(s), {})).toBe(1);
    expect(lines).toEqual(["FAIL — NOPE_URL is not set"]);
  });

  it("prints its usage for anything it does not understand", async () => {
    const lines: string[] = [];
    expect(await onboardCommand(["frobnicate"], (s) => lines.push(s), {})).toBe(1);
    expect(lines[0]).toMatch(/^typesys onboard/);
  });
});
