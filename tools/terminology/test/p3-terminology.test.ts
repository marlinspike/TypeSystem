import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findViolations } from "../terminology.js";

/**
 * Independent review (P3) of `npm run check:terminology` (ADR-0064): ways
 * the retired product name reaches the tree while the check passes. Each
 * test runs the real script in a scratch git repository holding one file.
 */
const retired = ["Type", "S"].join("");
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/check-terminology.ts");
const TSX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules/.bin/tsx");

let repo: string | undefined;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

/** Runs the check over a fresh repository holding `files`; returns its exit status. */
function check(files: Record<string, string | Buffer>): number {
  repo = mkdtempSync(path.join(tmpdir(), "p3-terminology-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(repo, name), body);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  return spawnSync(TSX, [SCRIPT], { cwd: repo, encoding: "utf8" }).status ?? -1;
}

describe("P3 terminology bypasses (ADR-0064)", () => {
  it("control: the check fails on a plain text file using the retired name", () => {
    expect(check({ "notes.md": `Welcome to ${retired}.\n` })).toBe(1);
  });

  it("P3-T1: one NUL byte anywhere in a text file hides every use of the retired name in it", { timeout: 30_000 }, () => {
    expect(check({ "notes.md": `Welcome to ${retired}.\n<!-- \u0000 -->\n` })).toBe(1);
  });

  it("P3-T1: a UTF-16 text file (NUL bytes between letters) is skipped entirely", { timeout: 30_000 }, () => {
    expect(check({ "notes.txt": Buffer.from(`\ufeffWelcome to ${retired}.\n`, "utf16le") })).toBe(1);
  });

  it("P3-T2: the retired name in a tracked file's path is never checked", { timeout: 30_000 }, () => {
    expect(check({ [`${retired}-guide.md`]: "Nothing to see.\n" })).toBe(1);
  });

  it("P3-T3: the allow marker needs a reason (ADR-0064), but a bare marker anywhere on the line suffices", () => {
    expect(findViolations("a.json", `{"name":"${retired}","x":"terminology-allow"}`)).toHaveLength(1);
  });
});
