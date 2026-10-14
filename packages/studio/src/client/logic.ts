/**
 * What the Studio's screens compute, kept free of React and the DOM so it is
 * tested directly. None of it decides anything: validation, plans and
 * results all come from the API, and this only reads and rewrites the text
 * the person typed.
 */
import type { ExecutionPlan, ExecutionStep, QueryFilter, SemanticQuery } from "@typesys/core";

/** A query diagnostic as `POST /query/validate` returns it (`@typesys/devkit`). */
export interface QueryDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  /** A JSON Pointer into the query. */
  readonly path: string;
  readonly message: string;
  readonly suggestion?: string;
}

export type Parsed = { readonly ok: true; readonly query: SemanticQuery } | { readonly ok: false; readonly error: string };

/** The editor's text as a query, or why it is not one. Whether the query is valid is the API's answer (`validate`), not this. */
export function parseQuery(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "A query is a JSON object" };
  if (typeof (value as { type?: unknown }).type !== "string") return { ok: false, error: 'A query names its Type: { "type": "airforce.Aircraft" }' };
  return { ok: true, query: value as SemanticQuery };
}

/** RFC 6901: `/include/0/relationship` → `["include", "0", "relationship"]`. */
export function pointerTokens(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Not a JSON Pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The editor's text with the diagnostic's suggested name written where the
 * diagnostic points, re-indented. It returns `text` unchanged when there is
 * no suggestion, the text no longer parses, or the pointer no longer reaches
 * a string (the person has edited it since).
 */
export function applySuggestion(text: string, diagnostic: Pick<QueryDiagnostic, "path" | "suggestion">): string {
  if (diagnostic.suggestion === undefined) return text;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return text;
  }
  const tokens = pointerTokens(diagnostic.path);
  const last = tokens.pop();
  if (last === undefined) return text;
  let parent: unknown = root;
  for (const t of tokens) {
    if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, t)) return text;
    parent = (parent as Record<string, unknown>)[t];
  }
  if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, last)) return text;
  const holder = parent as Record<string, unknown>;
  if (typeof holder[last] !== "string") return text;
  holder[last] = diagnostic.suggestion;
  return JSON.stringify(root, null, 2);
}

function filterText(filter: QueryFilter): string {
  if ("and" in filter) return `(${filter.and.map(filterText).join(" and ")})`;
  if ("or" in filter) return `(${filter.or.map(filterText).join(" or ")})`;
  return `${filter.property} ${filter.operator} ${JSON.stringify(filter.value)}`;
}

function stepLine(step: ExecutionStep): string {
  switch (step.op) {
    case "classification-gate":
      return step.marked ? "Check the caller's clearance against the Type's marking" : "No classification marking on this Type";
    case "scan":
      return [
        `Scan ${step.dataSourceId}, ${step.pageSize} per page`,
        step.pushdownFilter ? `, filtered in the source by ${filterText(step.pushdownFilter)}` : "",
        step.authorizationPredicate ? ", with the caller's access rule pushed down" : "",
        step.sort?.length ? `, sorted by ${step.sort.map((s) => `${s.property} ${s.direction ?? "asc"}`).join(", ")}` : ""
      ].join("");
    case "merge-overrides":
      return `Merge values from ${step.dataSourceIds.join(", ")} (${step.callsPerObject} call${step.callsPerObject === 1 ? "" : "s"} per object)`;
    case "authorize-rows":
      return `Decide each object for this caller with ${step.policyName}`;
    case "compute":
      return `Compute ${step.properties.map((p) => (p.dependsOn.length ? `${p.name} from ${p.dependsOn.join(", ")}` : p.name)).join("; ")}`;
    case "redact":
      return `Withhold values the caller may not see${step.marked.length ? `, including marked ${step.marked.join(", ")}` : ""}`;
    case "residual-filter":
      return `Filter after computing by ${filterText(step.filter)}, reading at most ${step.maxScanned} objects`;
    case "project":
      return `Return only ${step.select.join(", ")}`;
    case "include":
      return `Include ${step.relationship} (${step.targetType} from ${step.dataSourceId})${step.filtered ? ", filtered" : ""}, depth ${step.depth}`;
  }
}

/** An execution plan (ADR-0054) as numbered sentences, then its notes. */
export function planLines(plan: ExecutionPlan): string[] {
  const steps = plan.steps.map((s, i) => `${i + 1}. ${stepLine(s)}`);
  const { overrides, computed } = plan.adapterCallsPerObject;
  const calls = overrides + computed > 0 ? [`Extra adapter calls per object: ${overrides} for overrides, ${computed} for computed values`] : [];
  return [...steps, ...calls, ...plan.notes];
}

/** One value in a table cell. Absent (withheld or not set) is an empty cell, never a guess. */
export function formatCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The keys to show for a page of rows: `preferred` first when given, then any other the rows carry, in first-seen order. */
export function columnKeys(rows: readonly { readonly values: Readonly<Record<string, unknown>> }[], preferred: readonly string[] = []): string[] {
  const keys = new Set(preferred);
  for (const r of rows) for (const k of Object.keys(r.values)) keys.add(k);
  return [...keys];
}

/** Where a sign-in token is kept: this tab only, gone when it closes. */
export const TOKEN_KEY = "typesys.studio.token";

/** A starting query for a Type. */
export function starterQuery(type: string): string {
  return JSON.stringify({ type, limit: 10 }, null, 2);
}
