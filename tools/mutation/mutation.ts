import { createHash } from "node:crypto";

/**
 * The mutation catalog and what a run records (ADR-0070). A mutation is a
 * deliberate defect in a security mechanism, stated as an exact text
 * replacement so it applies to the same code every time and goes stale
 * loudly when that code changes. Each names the tests that must catch it.
 */
export const CATALOG_FORMAT = "typesys.mutation-catalog/1";
export const EVIDENCE_FORMAT = "typesys.mutation-evidence/1";

export interface Mutation {
  /** Stable, kebab-case: `<mechanism>.<what-breaks>`. */
  readonly id: string;
  /** The ADR whose guarantee the mutation breaks, e.g. `0067`. */
  readonly adr: string;
  /** What the defect does, in words. */
  readonly description: string;
  /** Repository-relative path of the file to mutate. */
  readonly file: string;
  /** Exact text to replace. Must occur exactly once, unless `occurrence` picks one. */
  readonly find: string;
  readonly replace: string;
  /** 1-based: which occurrence of `find` to replace, when it occurs more than once. */
  readonly occurrence?: number;
  /** Repository-relative test files that must fail with the mutation applied. */
  readonly tests: readonly string[];
  /** Environment variables the tests need to run at all (e.g. `DATABASE_URL`); without one the mutation is not run. */
  readonly requires?: readonly string[];
  /** Why the mutation cannot change behavior, when it cannot: a survivor marked so does not fail the run. */
  readonly equivalent?: string;
}

export interface Catalog {
  readonly format: typeof CATALOG_FORMAT;
  readonly mutations: readonly Mutation[];
}

export type MutationStatus =
  /** A named test failed. */
  | "killed"
  /** The build failed: the defect does not compile. */
  | "killed-by-compiler"
  /** Every named test passed: the defect went unnoticed. */
  | "survived"
  /** Survived, and the catalog says why it cannot change behavior. */
  | "equivalent"
  /** Not run, because an environment variable it requires is unset. */
  | "not-run"
  /** `find` no longer matches the file as the catalog says: the catalog must be updated. */
  | "stale"
  /** The test run ended without a verdict (a signal, a timeout, a crash with no failing test): it proves nothing. */
  | "inconclusive";

export interface MutationResult {
  readonly id: string;
  readonly adr: string;
  readonly file: string;
  readonly status: MutationStatus;
  readonly durationMs: number;
  /** Up to five failing test names, for a killed mutation. */
  readonly failing?: readonly string[];
  readonly detail?: string;
}

export interface Evidence {
  readonly format: typeof EVIDENCE_FORMAT;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly command: string;
  readonly git: { readonly revision: string; readonly branch: string; readonly clean: boolean };
  readonly environment: Readonly<Record<string, string | boolean | number>>;
  readonly catalog: { readonly path: string; readonly sha256: string; readonly mutations: number };
  readonly results: readonly MutationResult[];
  readonly summary: Readonly<Record<MutationStatus, number>>;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** Every problem with a catalog document: shape, duplicate ids, unsafe paths. Empty means it can be run. */
export function catalogProblems(doc: unknown): string[] {
  const c = doc as Partial<Catalog> | null;
  if (!c || c.format !== CATALOG_FORMAT) return [`format is not ${CATALOG_FORMAT}`];
  if (!Array.isArray(c.mutations) || c.mutations.length === 0) return ["mutations is not a non-empty list"];
  const out: string[] = [];
  const seen = new Set<string>();
  const safePath = (p: unknown) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split(/[\\/]/).includes("..");
  for (const [i, m] of (c.mutations as Partial<Mutation>[]).entries()) {
    const at = `mutations[${i}]${typeof m.id === "string" ? ` (${m.id})` : ""}`;
    if (typeof m.id !== "string" || !ID.test(m.id)) out.push(`${at}: id must be <mechanism>.<what-breaks> in kebab-case`);
    else if (seen.has(m.id)) out.push(`${at}: duplicate id`);
    else seen.add(m.id);
    if (typeof m.adr !== "string" || !/^\d{4}$/.test(m.adr)) out.push(`${at}: adr must be four digits`);
    if (typeof m.description !== "string" || m.description === "") out.push(`${at}: description is missing`);
    if (!safePath(m.file)) out.push(`${at}: file must be a repository-relative path`);
    if (typeof m.find !== "string" || m.find === "") out.push(`${at}: find is missing`);
    if (typeof m.replace !== "string") out.push(`${at}: replace is missing`);
    else if (m.replace === m.find) out.push(`${at}: replace is the same as find`);
    if (m.occurrence !== undefined && (!Number.isInteger(m.occurrence) || m.occurrence < 1)) out.push(`${at}: occurrence must be a positive integer`);
    if (!Array.isArray(m.tests) || m.tests.length === 0 || !m.tests.every(safePath)) out.push(`${at}: tests must list repository-relative test files`);
    if (m.requires !== undefined && (!Array.isArray(m.requires) || !m.requires.every((r) => typeof r === "string" && /^[A-Z_][A-Z0-9_]*$/.test(r)))) out.push(`${at}: requires must list environment variable names`);
    if (m.equivalent !== undefined && (typeof m.equivalent !== "string" || m.equivalent.trim() === "")) out.push(`${at}: equivalent must give a reason`);
  }
  return out;
}

/**
 * `source` with the mutation applied, or why it cannot be: `find` absent,
 * or present more often than the catalog says, which means the code moved
 * and the mutation might now break something other than what it names.
 */
export function applyMutation(source: string, m: Pick<Mutation, "find" | "replace" | "occurrence">): { mutated: string } | { stale: string } {
  const positions: number[] = [];
  for (let at = source.indexOf(m.find); at !== -1; at = source.indexOf(m.find, at + 1)) positions.push(at);
  if (positions.length === 0) return { stale: "the text to replace is not in the file" };
  if (m.occurrence === undefined && positions.length > 1) return { stale: `the text to replace occurs ${positions.length} times; say which with occurrence` };
  const index = (m.occurrence ?? 1) - 1;
  if (index >= positions.length) return { stale: `occurrence ${m.occurrence} asked for, ${positions.length} found` };
  const at = positions[index]!;
  return { mutated: source.slice(0, at) + m.replace + source.slice(at + m.find.length) };
}

/** SHA-256 of the catalog file's bytes: the evidence names exactly the catalog it ran. */
export function catalogHash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** What a mutation's outcome is, from what happened when it ran. */
export function classify(m: Pick<Mutation, "equivalent">, run: { compiled: boolean; testsFailed: boolean; inconclusive?: boolean }): MutationStatus {
  if (!run.compiled) return "killed-by-compiler";
  if (run.inconclusive) return "inconclusive";
  if (run.testsFailed) return "killed";
  return m.equivalent ? "equivalent" : "survived";
}

export function summarize(results: readonly Pick<MutationResult, "status">[]): Record<MutationStatus, number> {
  const summary: Record<MutationStatus, number> = { killed: 0, "killed-by-compiler": 0, survived: 0, equivalent: 0, "not-run": 0, stale: 0, inconclusive: 0 };
  for (const r of results) summary[r.status]++;
  return summary;
}

/** Whether a run is evidence that every catalogued defect is caught: nothing survived, went stale, or was left unrun unless allowed. */
export function passed(summary: Readonly<Record<MutationStatus, number>>, opts: { allowNotRun?: boolean } = {}): boolean {
  return summary.survived === 0 && summary.stale === 0 && summary.inconclusive === 0 && (opts.allowNotRun === true || summary["not-run"] === 0);
}
