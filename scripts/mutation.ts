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
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
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
const npxSync = (a: string[]) => spawnSync("npx", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The child running now, so a signal can stop it before the tree is restored. */
let current: ChildProcess | undefined;
/** The longest one build or test run may take before it is stopped and called inconclusive. */
const STEP_TIMEOUT_MS = 20 * 60_000;
/**
 * Runs `npx …` without blocking the event loop, so a signal reaches this
 * script's handler while a build or a test run is under way (P3-M1).
 */
const npx = (a: string[]): Promise<{ status: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve) => {
    const child = spawn("npx", a, { stdio: "ignore" });
    current = child;
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ status: null, signal: null });
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      if (current === child) current = undefined;
      resolve({ status, signal });
    });
  });

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
const versionOf = (cmd: string, a: string[]) => npxSync([cmd, ...a]).stdout.trim().split("\n")[0] ?? "";
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
/** A synchronous forced rebuild, for the signal handler: the output must not keep the defect either. */
const rebuildSync = (files: Iterable<string>) => {
  for (const file of new Set(files)) spawnSync("npx", ["tsc", "-b", "--force", ".", ...extraProject(file)], { stdio: "ignore" });
};
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    current?.kill("SIGKILL");
    const mutated = [...originals.keys()];
    restore();
    if (mutated.length > 0) rebuildSync(mutated);
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A signal before the scratch directory exists.
    }
    process.exit(130);
  });

/**
 * A forced rebuild of everything the root project builds, and of the mutated
 * file's own package when the root leaves it out (the Postgres packages,
 * built by `npm run build:postgres`), so no test runs against stale output.
 */
function extraProject(file?: string): string[] {
  const own = file?.match(/^packages\/[^/]+/)?.[0];
  return own && existsSync(path.join(own, "tsconfig.json")) && !rootProjects.has(own) ? [own] : [];
}
const build = (file?: string) => npx(["tsc", "-b", "--force", ".", ...extraProject(file)]);
const scratch = mkdtempSync(path.join(tmpdir(), "typesys-mutation-"));
/**
 * Runs vitest on `tests`; returns whether a test or a test file failed, up
 * to five failing names, and whether the run was inconclusive: stopped by a
 * signal or the step timeout, or exiting non-zero with no report or with a
 * report in which nothing failed (P3-M4). Only a reported failure is a kill.
 */
const test = async (tests: readonly string[]) => {
  const report = path.join(scratch, "report.json");
  rmSync(report, { force: true });
  const r = await npx(["vitest", "run", ...tests, "--reporter=json", `--outputFile=${report}`]);
  let failing: string[] = [];
  let ran = 0;
  let failedFiles = 0;
  let reported = false;
  try {
    const json = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number; numFailedTests: number; numFailedTestSuites?: number; testResults: { status?: string; name?: string; assertionResults: { fullName: string; status: string }[] }[] };
    reported = true;
    ran = json.numPassedTests + json.numFailedTests;
    failedFiles = json.numFailedTestSuites ?? 0;
    failing = json.testResults.flatMap((f) => {
      const tests = f.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName);
      // A file that failed with no failing test did not load: the mutated module broke it.
      return tests.length > 0 || f.status !== "failed" ? tests : [`${path.relative(process.cwd(), f.name ?? "")} (did not load)`];
    });
  } catch {
    // No report: the run ended before vitest could write one.
  }
  const failed = reported && (failing.length > 0 || failedFiles > 0);
  const inconclusive = r.signal !== null || (r.status !== 0 && !failed);
  return { failed, failing: failing.slice(0, 5), ran, inconclusive };
};

console.log(`mutation: ${selected.length} mutation(s) from ${CATALOG} at ${git("rev-parse", "--short", "HEAD")}${clean ? "" : " (dirty tree)"}`);
for (const file of new Set(selected.map((m) => m.file))) {
  if ((await build(file)).status !== 0) {
    console.error("mutation: the unmutated tree does not build");
    process.exit(2);
  }
}
const baselineTests = [...new Set(selected.filter((m) => (m.requires ?? []).every((v) => process.env[v])).flatMap((m) => m.tests))];
const baseline = await test(baselineTests);
if (baseline.failed || baseline.inconclusive) {
  console.error(`mutation: the named tests fail without any mutation, so no result would mean anything:\n- ${baseline.failing.join("\n- ")}`);
  process.exit(2);
}

const results: MutationResult[] = [];
try {
  for (const m of selected) results.push(await runOne(m));
} finally {
  restore();
  for (const file of new Set(selected.map((m) => m.file))) await build(file);
  rmSync(scratch, { recursive: true, force: true });
}

async function runOne(m: Mutation): Promise<MutationResult> {
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
    const compiled = (await build(m.file)).status === 0;
    const tests = compiled ? await test(m.tests) : { failed: false, failing: [], ran: 0, inconclusive: false };
    const status = classify(m, { compiled, testsFailed: tests.failed, inconclusive: tests.inconclusive });
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
  for (const r of results.filter((x) => x.status === "survived" || x.status === "stale" || x.status === "not-run" || x.status === "inconclusive")) console.error(`  ${r.status}: ${r.id}${r.detail ? ` (${r.detail})` : ""}`);
  process.exit(1);
}
