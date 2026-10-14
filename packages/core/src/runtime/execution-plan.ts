import type { QueryFilter, SemanticQuery } from "../model/query.js";
import { filterProperties } from "./filter.js";
import { InvalidInputError } from "./errors.js";

/**
 * A query filter divided by where it can run (ADR-0054). `pushdown` names only
 * stored properties and goes to the adapter; `residual` names at least one
 * computed property and runs in the runtime on each object's finalized,
 * caller-visible values. Their conjunction is the original filter.
 */
export interface FilterSplit {
  pushdown?: QueryFilter;
  residual?: QueryFilter;
}

function conjunction(parts: QueryFilter[]): QueryFilter | undefined {
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

/**
 * Splits `filter` at its top-level conjunction (flattening nested `and`s): a
 * conjunct that references a computed property anywhere runs in the runtime,
 * every other conjunct in the adapter. An `or` is never split, since half of a
 * disjunction is not a sound pre-filter. Pure: the same split for the same
 * filter, which is what lets `explainQuery` report exactly what `query` does.
 */
export function splitFilter(filter: QueryFilter | undefined, isComputed: (property: string) => boolean): FilterSplit {
  if (!filter) return {};
  const conjuncts: QueryFilter[] = [];
  const stack: QueryFilter[] = [filter];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if ("and" in node) stack.unshift(...node.and);
    else conjuncts.push(node);
  }
  const pushdown: QueryFilter[] = [];
  const residual: QueryFilter[] = [];
  for (const c of conjuncts) ([...filterProperties(c)].some(isComputed) ? residual : pushdown).push(c);
  const split: FilterSplit = {};
  const p = conjunction(pushdown);
  const r = conjunction(residual);
  if (p) split.pushdown = p;
  if (r) split.residual = r;
  return split;
}

/**
 * Where a runtime-filtered query resumes (ADR-0054): the adapter cursor of the
 * page it stopped in, and how many of that page's rows it already consumed.
 * Opaque to callers, and only ever produced and accepted for a query whose
 * filter has a runtime part, so every other query's cursor is the adapter's own.
 */
export interface ScanPosition {
  cursor?: string;
  skip: number;
}

const SCAN_CURSOR_PREFIX = "ts1.";

export function encodeScanCursor(position: ScanPosition): string {
  return SCAN_CURSOR_PREFIX + Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeScanCursor(cursor: string | undefined): ScanPosition {
  if (cursor === undefined) return { skip: 0 };
  const invalid = () => new InvalidInputError("Invalid query: cursor was not issued for a query filtered on computed properties; pass the nextCursor this query returned");
  if (!cursor.startsWith(SCAN_CURSOR_PREFIX)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(SCAN_CURSOR_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const { cursor: inner, skip } = (parsed ?? {}) as { cursor?: unknown; skip?: unknown };
  if ((inner !== undefined && typeof inner !== "string") || typeof skip !== "number" || !Number.isInteger(skip) || skip < 0) throw invalid();
  return inner === undefined ? { skip } : { cursor: inner, skip };
}

/** Whether a cursor is a runtime scan cursor, so a query without a runtime filter can refuse one. */
export function isScanCursor(cursor: string | undefined): boolean {
  return cursor?.startsWith(SCAN_CURSOR_PREFIX) === true;
}

/**
 * One step of how `query` will run (ADR-0054), in execution order. A
 * description derived from the same decisions `query` makes, not a separate
 * planner, so it cannot drift from what runs.
 */
export type ExecutionStep =
  | { op: "classification-gate"; marked: boolean }
  | { op: "scan"; dataSourceId: string; pushdownFilter?: QueryFilter; authorizationPredicate: boolean; sort?: SemanticQuery["sort"]; pageSize: number }
  | { op: "merge-overrides"; dataSourceIds: string[]; callsPerObject: number }
  | { op: "authorize-rows"; policyName: string; decidedPerObject: true }
  | { op: "compute"; properties: { name: string; dependsOn: string[] }[] }
  | { op: "redact"; memberPolicies: string[]; marked: string[] }
  | { op: "residual-filter"; filter: QueryFilter; maxScanned: number }
  | { op: "project"; select: string[] }
  | { op: "include"; relationship: string; targetType: string; dataSourceId: string; depth: number; filtered: boolean };

export interface ExecutionPlan {
  steps: ExecutionStep[];
  /** Adapter calls per returned object beyond the scan, before includes: overrides, plus computed properties that may call adapters. */
  adapterCallsPerObject: { overrides: number; computed: number };
  /** Things worth knowing before running the query, in plain words. */
  notes: string[];
}
