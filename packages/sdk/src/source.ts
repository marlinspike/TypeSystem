import type { QueryFilter, QueryInclude, SemanticQuery, SortKey } from "@typesys/core";

export interface SourceOptions {
  /** The client variable the code starts from. Default `client`. */
  readonly client?: string;
  /** Spaces before each chained call. Default 2. */
  readonly indent?: number;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const lit = (value: unknown): string => JSON.stringify(value);
const member = (obj: string, name: string): string => (IDENT.test(name) ? `${obj}.${name}` : `${obj}[${lit(name)}]`);

/** A filter as field-reference calls on `f`: `f.needsAttention.eq(true).and(f.model.in(["F-16C"]))`. */
function expr(filter: QueryFilter, f: string): string {
  if ("and" in filter || "or" in filter) {
    const op = "and" in filter ? "and" : "or";
    const parts = "and" in filter ? filter.and : filter.or;
    if (parts.length === 0) throw new Error(`An empty "${op}" has no SDK form`);
    // Each part is one argument, so a nested combination keeps its own grouping.
    const [first, ...rest] = parts.map((p) => expr(p, f));
    return rest.length === 0 ? first! : `${first}.${op}(${rest.join(", ")})`;
  }
  return `${member(f, filter.property)}.${filter.operator}(${lit(filter.value)})`;
}

function sorts(sort: readonly SortKey[] | undefined): string[] {
  return (sort ?? []).map((s) => `.orderBy(${lit(s.property)}${s.direction === "desc" ? `, "desc"` : ""})`);
}

function includeCalls(includes: readonly QueryInclude[] | undefined, depth: number): string[] {
  return (includes ?? []).map((inc) => {
    const q = depth === 0 ? "q" : `q${depth}`;
    const inner = [
      ...(inc.filter ? [`.where((f) => ${expr(inc.filter, "f")})`] : []),
      ...sorts(inc.sort),
      ...(inc.select ? [`.select(${inc.select.map(lit).join(", ")})`] : []),
      ...includeCalls(inc.include, depth + 1),
      ...(inc.limit !== undefined ? [`.limit(${inc.limit})`] : [])
    ];
    return inner.length === 0 ? `.include(${lit(inc.relationship)})` : `.include(${lit(inc.relationship)}, (${q}) => ${q}${inner.join("")})`;
  });
}

/**
 * The typed SDK code that builds `query` (ADR-0055, ADR-0061): the inverse
 * of `toQuery()`, so a query composed or checked anywhere (Studio, an
 * agent, a log) becomes code a developer pastes. Its `toQuery()` is the
 * same query, with nested conjunctions of one kind flattened as the
 * builder always does; a cursor is left out, since it belongs to `page()`.
 */
export function querySource(query: SemanticQuery, opts: SourceOptions = {}): string {
  const pad = `\n${" ".repeat(opts.indent ?? 2)}`;
  const calls = [
    ...(query.filter ? [`.where((f) => ${expr(query.filter, "f")})`] : []),
    ...(query.search ? [`.search(${lit(query.search.text)}${query.search.properties ? `, ${lit(query.search.properties)}` : ""})`] : []),
    ...sorts(query.sort),
    ...(query.select ? [`.select(${query.select.map(lit).join(", ")})`] : []),
    ...includeCalls(query.include, 0),
    ...(query.limit !== undefined ? [`.limit(${query.limit})`] : []),
    ...(query.includeProvenance ? [".withProvenance()"] : [])
  ];
  return `${opts.client ?? "client"}.from(${lit(query.type)})${calls.map((c) => pad + c).join("")}`;
}
