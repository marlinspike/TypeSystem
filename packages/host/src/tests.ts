import { readFile } from "node:fs/promises";
import { AuthorizationError, composedProperties, type Identity, type SemanticQuery } from "@typesys/core";
import { didYouMean } from "@typesys/devkit";
import { DeploymentError } from "./deployment.js";
import type { Host } from "./host.js";

/**
 * Policy tests as data (ADR-0113): what a deployment's rules must keep
 * true, written beside it as `<name>.tests.json` and checked by `typesys
 * deploy test` and `typesys dev`. Each test reads, queries or previews as
 * one of the deployment's personas, through the governed runtime, so it
 * decides exactly what a caller with that persona's identity would get.
 */
export const TESTS_FORMAT = "typesys.deployment-tests/1";

export interface DeploymentTest {
  /** What the test promises, in words; shown when it fails. Default: made from the rest. */
  readonly name?: string;
  /** The persona it runs as: one the deployment declares, or `anonymous`. */
  readonly as: string;
  /** Read one object, `<Type>/<id>`. */
  readonly read?: string;
  /** Query a Type: its name (the first 50 objects), or a query. */
  readonly query?: string | SemanticQuery;
  /** Preview an Action: authorized or not, without running it. */
  readonly invoke?: { readonly action: string; readonly input: unknown };
  /** The persona is refused: the read, the query or the Action. */
  readonly refused?: boolean;
  /** For a read, each is in the object; for a query, each is in at least one object, and the query returned some. */
  readonly returns?: readonly string[];
  /** None is in the object, or in any object the query returned. */
  readonly withholds?: readonly string[];
}

export interface DeploymentTests {
  readonly format: typeof TESTS_FORMAT;
  readonly tests: readonly DeploymentTest[];
}

export interface TestOutcome {
  readonly name: string;
  readonly ok: boolean;
  /** Why it failed, or what it saw when it passed. */
  readonly detail: string;
}

export interface TestReport {
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly outcomes: readonly TestOutcome[];
}

/** Objects one query test reads, in pages of PAGE, at most (unless its query sets a limit). */
const PAGE = 100;
const MAX_OBJECTS = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

/** Every problem with a tests document, each naming the test by position. Empty means it can run. */
export function validateTests(doc: unknown, personas: readonly string[]): string[] {
  if (!isRecord(doc) || doc.format !== TESTS_FORMAT) return [`must be a ${TESTS_FORMAT} document: { "format": "${TESTS_FORMAT}", "tests": [...] }`];
  if (!Array.isArray(doc.tests)) return ["tests: must be a list"];
  const out: string[] = [];
  doc.tests.forEach((t: unknown, i: number) => {
    const at = `tests[${i}]`;
    if (!isRecord(t)) {
      out.push(`${at}: must be an object`);
      return;
    }
    for (const k of Object.keys(t)) if (!["name", "as", "read", "query", "invoke", "refused", "returns", "withholds"].includes(k)) out.push(`${at}: unknown field "${k}"`);
    if (typeof t.as !== "string" || !personas.includes(t.as)) out.push(`${at}.as: must name a persona the deployment declares (${personas.join(", ")})${typeof t.as === "string" ? `, not "${t.as}"` : ""}`);
    const kinds = (["read", "query", "invoke"] as const).filter((k) => t[k] !== undefined);
    if (kinds.length !== 1) out.push(`${at}: must have exactly one of read, query, invoke`);
    if (t.read !== undefined && (typeof t.read !== "string" || t.read.indexOf("/") <= 0 || t.read.endsWith("/"))) out.push(`${at}.read: must be "<Type>/<id>"`);
    if (t.query !== undefined && typeof t.query !== "string" && !(isRecord(t.query) && typeof t.query.type === "string")) out.push(`${at}.query: must be a Type's name or a query with a "type"`);
    if (t.invoke !== undefined && !(isRecord(t.invoke) && typeof t.invoke.action === "string" && "input" in t.invoke)) out.push(`${at}.invoke: must be { "action": "<Action>", "input": {...} }`);
    if (t.refused !== undefined && typeof t.refused !== "boolean") out.push(`${at}.refused: must be true or false`);
    for (const k of ["returns", "withholds"] as const) if (t[k] !== undefined && !strings(t[k])) out.push(`${at}.${k}: must be a list of property names`);
    if (t.invoke !== undefined && (t.returns !== undefined || t.withholds !== undefined)) out.push(`${at}: an invoke test says only whether the persona is refused`);
    if (t.refused === true && (t.returns !== undefined || t.withholds !== undefined)) out.push(`${at}: a refused test returns nothing to compare`);
  });
  return out;
}

/**
 * Every property a test names that its Type does not have, and every Type
 * no pack registers: a misspelt `withholds` would otherwise pass forever.
 */
async function namingProblems(doc: DeploymentTests, registry: Host["registry"]): Promise<string[]> {
  const out: string[] = [];
  const types = await registry.listTypes();
  const known = new Map<string, string[]>();
  for (const [i, t] of doc.tests.entries()) {
    const typeName = t.read ? t.read.slice(0, t.read.indexOf("/")) : t.query ? (typeof t.query === "string" ? t.query : t.query.type) : undefined;
    if (typeName === undefined) continue;
    const type = types.find((x) => x.name === typeName);
    if (!type) {
      const near = didYouMean(typeName, types.map((x) => x.name));
      out.push(`tests[${i}]: no pack has a Type ${typeName}${near ? ` (did you mean ${near}?)` : ""}`);
      continue;
    }
    if (!known.has(typeName)) known.set(typeName, [...Object.keys((await composedProperties(registry, type)).properties), ...Object.keys((type.schema as { "x-computed"?: Record<string, unknown> })["x-computed"] ?? {})]);
    const names = known.get(typeName)!;
    for (const k of ["returns", "withholds"] as const)
      for (const p of t[k] ?? []) {
        if (names.includes(p)) continue;
        const near = didYouMean(p, names);
        out.push(`tests[${i}].${k}: ${typeName} has no property "${p}"${near ? ` (did you mean "${near}"?)` : ""}`);
      }
  }
  return out;
}

/** Reads and checks a tests file against the host's personas and model. */
export async function loadTests(file: string, host: Pick<Host, "personas" | "registry">): Promise<DeploymentTests> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new DeploymentError([`${file}: ${err instanceof Error ? err.message : String(err)}`]);
  }
  const problems = validateTests(doc, Object.keys(host.personas));
  if (problems.length > 0) throw new DeploymentError(problems.map((p) => `${file}: ${p}`));
  const naming = await namingProblems(doc as DeploymentTests, host.registry);
  if (naming.length > 0) throw new DeploymentError(naming.map((p) => `${file}: ${p}`));
  return doc as DeploymentTests;
}

const describeTest = (t: DeploymentTest): string => {
  const what = t.read ? `reads ${t.read}` : t.query ? `queries ${typeof t.query === "string" ? t.query : t.query.type}` : `invokes ${t.invoke!.action}`;
  const expect = t.refused ? ", refused" : `${t.returns?.length ? `, returns ${t.returns.join(", ")}` : ""}${t.withholds?.length ? `, withholds ${t.withholds.join(", ")}` : ""}`;
  return `${t.as} ${what}${expect}`;
};

/** Runs one test; never throws for what the runtime decides, only reports it. */
async function runOne(host: Host, t: DeploymentTest): Promise<TestOutcome> {
  const name = t.name ?? describeTest(t);
  const who: Identity = host.personas[t.as]!;
  const refusedWanted = t.refused === true;
  try {
    if (t.invoke) {
      const preview = await host.runtime.previewAction(t.invoke.action, t.invoke.input, who);
      // Only the policy's decision counts: a target that does not exist, or an Action that waits for approval, says nothing about who may invoke it.
      const denied = preview.blockers.filter((b) => b.kind === "authorization");
      const missing = preview.blockers.find((b) => b.kind === "target");
      if (missing) return { name, ok: false, detail: `inconclusive: ${missing.message}, so the policy's decision could not be shown; name a target that exists` };
      const refused = denied.length > 0;
      return refused === refusedWanted
        ? { name, ok: true, detail: refused ? "refused" : "authorized" }
        : { name, ok: false, detail: refused ? `refused: ${denied.map((b) => b.message).join("; ")}` : "authorized, and the test says it must be refused" };
    }
    let objects: Record<string, unknown>[];
    if (t.read) {
      const at = t.read.indexOf("/");
      objects = [(await host.runtime.getObject(t.read.slice(0, at), t.read.slice(at + 1), who)).values];
    } else {
      // Every page, up to MAX_OBJECTS, so an object past the first page is checked too.
      const base: SemanticQuery = typeof t.query === "string" ? { type: t.query } : t.query!;
      objects = [];
      let cursor: string | undefined;
      do {
        const page = await host.runtime.query({ ...base, limit: Math.min(base.limit ?? PAGE, PAGE), ...(cursor ? { cursor } : {}) }, who);
        objects.push(...page.items.map((o) => (o as { values: Record<string, unknown> }).values));
        cursor = page.nextCursor;
      } while (cursor && objects.length < (base.limit ?? MAX_OBJECTS));
      // Refused means the runtime refused the query (it throws, below); an empty answer may only mean the table is empty.
      if (refusedWanted)
        return objects.length === 0
          ? { name, ok: false, detail: "inconclusive: the query returned no objects without being refused, so a refusal could not be shown (an empty table, or a rule that decides per object: test a read of one instead)" }
          : { name, ok: false, detail: `returned ${objects.length} object(s), and the test says it must be refused` };
      if (objects.length === 0 && t.withholds?.length) return { name, ok: false, detail: "inconclusive: the query returned no objects, so nothing it withholds could be checked" };
    }
    if (refusedWanted) return { name, ok: false, detail: "allowed, and the test says it must be refused" };
    const problems: string[] = [];
    for (const p of t.withholds ?? []) {
      const seen = objects.filter((o) => Object.hasOwn(o, p)).length;
      if (seen > 0) problems.push(`${p} was returned${t.query ? ` on ${seen} of ${objects.length} objects` : ""}`);
    }
    if (t.returns?.length && objects.length === 0) problems.push("the query returned no objects, so nothing it returns could be checked");
    else for (const p of t.returns ?? []) if (!objects.some((o) => Object.hasOwn(o, p))) problems.push(`${p} was not returned`);
    return problems.length ? { name, ok: false, detail: problems.join("; ") } : { name, ok: true, detail: t.query ? `${objects.length} object(s)` : "as expected" };
  } catch (err) {
    if (err instanceof AuthorizationError) return refusedWanted ? { name, ok: true, detail: "refused" } : { name, ok: false, detail: `refused: ${err.reason ?? err.message}` };
    return { name, ok: false, detail: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

/**
 * For a deployment whose callers sign in through a provider with a role map
 * (ADR-0124): can someone be what each tested persona is? A persona whose
 * roles no one group grants is tested with more than a member of any one of
 * its groups would hold, so a test can pass for a caller who would be refused.
 */
export function roleMapOutcomes(host: Pick<Host, "deployment" | "personas">, personas: readonly string[]): TestOutcome[] {
  const id = host.deployment.identity;
  if (id?.kind !== "oidc" || id.roleMap === undefined) return [];
  const entries = Object.entries(id.roleMap);
  const out: TestOutcome[] = [];
  for (const name of [...new Set(personas)].filter((n) => n !== "anonymous").sort()) {
    const roles = host.personas[name]?.roles ?? [];
    if (roles.length === 0) continue;
    const group = entries.find(([, granted]) => roles.every((r) => granted.includes(r)));
    const label = `persona ${name} [${roles.join(", ")}] can sign in through identity.roleMap`;
    if (group) out.push({ name: label, ok: true, detail: `group ${group[0]}` });
    else {
      const partial = entries.filter(([, granted]) => granted.some((r) => roles.includes(r))).map(([g, granted]) => `${g} grants [${granted.join(", ")}]`);
      out.push({
        name: label,
        ok: false,
        detail: `no one group grants all of [${roles.join(", ")}]${partial.length ? ` (${partial.join("; ")})` : ""}: a member of one group is refused what this persona's tests allow. Map a group to every role the persona holds.`
      });
    }
  }
  return out;
}

/** Runs every test, in order, then checks the personas they run as against the role map. */
export async function runTests(host: Host, doc: DeploymentTests): Promise<TestReport> {
  const outcomes: TestOutcome[] = [];
  for (const t of doc.tests) outcomes.push(await runOne(host, t));
  outcomes.push(...roleMapOutcomes(host, doc.tests.map((t) => t.as)));
  const failed = outcomes.filter((o) => !o.ok).length;
  return { ok: failed === 0, passed: outcomes.length - failed, failed, outcomes };
}

/** A report as text: one line per test, failures with why. */
export function renderTests(report: TestReport): string {
  const lines = report.outcomes.map((o) => `${o.ok ? "  ✓" : "  ✗"} ${o.name}${o.ok ? "" : `\n      ${o.detail}`}`);
  return `${lines.join("\n")}\n${report.ok ? "PASS" : "FAIL"}: ${report.passed} passed, ${report.failed} failed\n`;
}

/** Where a deployment's tests are, by convention: `<file without .deployment.json>.tests.json` beside it. */
export function testsFileFor(deploymentFile: string): string {
  return deploymentFile.replace(/(\.deployment)?\.json$/, "") + ".tests.json";
}
