/**
 * `npm run mutation` (ADR-0070): applies every mutation in the committed
 * catalog, one at a time, forces a full rebuild (`tsc -b --force`), runs the
 * tests the catalog names, restores the file, and writes an evidence record:
 * the git revision and whether the tree was clean, the environment, the
 * catalog's hash, and each mutation's result. Exits 1 when a mutation
 * survives (unless the catalog marks it equivalent), is stale, or could not
 * run for want of an environment variable (unless --allow-not-run).
 *
 *   npm run mutation [-- --only <id,...>] [--out <evidence.json>] [--allow-dirty] [--allow-not-run]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import path from "node:path";
import {
  EVIDENCE_FORMAT,
  applyMutation,
  catalogHash,
  catalogProblems,
  classify,
  passed,
  summarize,
  type Catalog,
  type Evidence,
  type Mutation,
  type MutationResult
} from "../tools/mutation/mutation.js";

const CATALOG = "tools/mutation/catalog.json";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = value("--out") ?? "docs/evidence/mutation/latest.json";
const only = value("--only")?.split(",").filter(Boolean);

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" }).trim();
const run = (cmd: string, a: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(cmd, a, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
const npx = (a: string[]) => run("npx", a);

const rootProjects = new Set((JSON.parse(readFileSync("tsconfig.json", "utf8")) as { references: { path: string }[] }).references.map((r) => r.path));
const bytes = readFileSync(CATALOG, "utf8");
const catalog = JSON.parse(bytes) as Catalog;
const problems = catalogProblems(catalog);
if (problems.length > 0) {
  console.error(`mutation: ${CATALOG} is malformed:\n- ${problems.join("\n- ")}`);
  process.exit(2);
}
const unknown = (only ?? []).filter((id) => !catalog.mutations.some((m) => m.id === id));
if (unknown.length > 0) {
  console.error(`mutation: no such mutation: ${unknown.join(", ")}`);
  process.exit(2);
}
const selected = only ? catalog.mutations.filter((m) => only.includes(m.id)) : catalog.mutations;

// The evidence file itself is the one change a run makes; an earlier run's copy does not make the tree dirty.
const relativeOut = path.relative(process.cwd(), path.resolve(out));
const inRepo = !relativeOut.startsWith("..") && !path.isAbsolute(relativeOut);
const clean = git("status", "--porcelain", "--", ".", ...(inRepo ? [`:(exclude)${relativeOut}`] : [])).length === 0;
if (!clean && !flag("--allow-dirty")) {
  console.error("mutation: the working tree has changes, so the evidence could not name the code it ran on. Commit them, or pass --allow-dirty (recorded).");
  process.exit(2);
}

const startedAt = new Date().toISOString();
const versionOf = (cmd: string, a: string[]) => npx([cmd, ...a]).stdout.trim().split("\n")[0] ?? "";
const environment = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  cpu: cpus()[0]?.model ?? "unknown",
  cpus: cpus().length,
  typescript: versionOf("tsc", ["--version"]),
  vitest: versionOf("vitest", ["--version"]),
  DATABASE_URL: process.env.DATABASE_URL !== undefined,
  ci: process.env.CI === "true"
};

// Whatever happens, every mutated file is put back: on an error, on Ctrl-C, on a kill.
const originals = new Map<string, string>();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    restore();
    process.exit(130);
  });

/**
 * A forced rebuild of everything the root project builds, and of the mutated
 * file's own package when the root leaves it out (the Postgres packages,
 * built by `npm run build:postgres`), so no test runs against stale output.
 */
const build = (file?: string) => {
  const own = file?.match(/^packages\/[^/]+/)?.[0];
  const extra = own && existsSync(path.join(own, "tsconfig.json")) && !rootProjects.has(own) ? [own] : [];
  return npx(["tsc", "-b", "--force", ".", ...extra]);
};
const scratch = mkdtempSync(path.join(tmpdir(), "typesys-mutation-"));
/** Runs vitest on `tests`; returns whether any failed, and up to five failing test names. */
const test = (tests: readonly string[]) => {
  const report = path.join(scratch, "report.json");
  rmSync(report, { force: true });
  const r = npx(["vitest", "run", ...tests, "--reporter=json", `--outputFile=${report}`]);
  let failing: string[] = [];
  let ran = 0;
  try {
    const json = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number; numFailedTests: number; testResults: { assertionResults: { fullName: string; status: string }[] }[] };
    ran = json.numPassedTests + json.numFailedTests;
    failing = json.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName));
  } catch {
    // No report: vitest itself failed (a module that no longer loads), which is a failure of the tests.
  }
  return { failed: r.status !== 0, failing: failing.slice(0, 5), ran };
};

console.log(`mutation: ${selected.length} mutation(s) from ${CATALOG} at ${git("rev-parse", "--short", "HEAD")}${clean ? "" : " (dirty tree)"}`);
if ([...new Set(selected.map((m) => m.file))].some((file) => build(file).status !== 0)) {
  console.error("mutation: the unmutated tree does not build");
  process.exit(2);
}
const baselineTests = [...new Set(selected.filter((m) => (m.requires ?? []).every((v) => process.env[v])).flatMap((m) => m.tests))];
const baseline = test(baselineTests);
if (baseline.failed) {
  console.error(`mutation: the named tests fail without any mutation, so no result would mean anything:\n- ${baseline.failing.join("\n- ")}`);
  process.exit(2);
}

const results: MutationResult[] = [];
try {
  for (const m of selected) results.push(runOne(m));
} finally {
  restore();
  for (const file of new Set(selected.map((m) => m.file))) build(file);
  rmSync(scratch, { recursive: true, force: true });
}

function runOne(m: Mutation): MutationResult {
  const started = Date.now();
  const base = { id: m.id, adr: m.adr, file: m.file };
  const missing = (m.requires ?? []).filter((v) => !process.env[v]);
  if (missing.length > 0) return { ...base, status: "not-run", durationMs: 0, detail: `needs ${missing.join(", ")}` };
  const source = readFileSync(m.file, "utf8");
  const applied = applyMutation(source, m);
  if ("stale" in applied) return { ...base, status: "stale", durationMs: 0, detail: applied.stale };
  originals.set(m.file, source);
  writeFileSync(m.file, applied.mutated);
  try {
    const compiled = build(m.file).status === 0;
    const tests = compiled ? test(m.tests) : { failed: false, failing: [], ran: 0 };
    const status = classify(m, { compiled, testsFailed: tests.failed });
    const result: MutationResult = { ...base, status, durationMs: Date.now() - started, ...(tests.failing.length > 0 ? { failing: tests.failing } : {}), ...(m.equivalent && status === "equivalent" ? { detail: m.equivalent } : {}) };
    console.log(`  ${status.padEnd(18)} ${m.id}${status === "killed" ? `  (${tests.failing[0] ?? "the test run failed"})` : ""}`);
    return result;
  } finally {
    writeFileSync(m.file, source);
    originals.delete(m.file);
  }
}

const summary = summarize(results);
const evidence: Evidence = {
  format: EVIDENCE_FORMAT,
  startedAt,
  finishedAt: new Date().toISOString(),
  command: ["npm run mutation", ...(args.length > 0 ? ["--", ...args] : [])].join(" "),
  git: { revision: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), clean },
  environment,
  catalog: { path: CATALOG, sha256: catalogHash(bytes), mutations: catalog.mutations.length },
  results,
  summary
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
const ok = passed(summary, { allowNotRun: flag("--allow-not-run") });
console.log(`mutation: ${Object.entries(summary).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(", ")}; evidence in ${out}`);
if (!ok) {
  for (const r of results.filter((x) => x.status === "survived" || x.status === "stale" || x.status === "not-run")) console.error(`  ${r.status}: ${r.id}${r.detail ? ` (${r.detail})` : ""}`);
  process.exit(1);
}
