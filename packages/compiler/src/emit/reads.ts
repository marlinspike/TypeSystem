import { isLiteral } from "../expr.js";
import type { Expr, FilterIR, IncludeIR, QueryIR, ReadIR } from "../ir.js";
import { exprTs, ident, q, type ExprTarget } from "./ts.js";

/**
 * One governed read as SDK calls on `client` (ADR-0082): the typed query
 * builder for a query, `get` for an object, `related` for a relationship,
 * `aggregate` for an aggregate. Every value the read takes from an
 * expression is wrapped in `need`, so a read whose parameter is unknown
 * never runs with a guess: in a flow the step fails naming the value, in
 * the interface the data wait for it.
 */
export function readTs(r: ReadIR, target: ExprTarget): string {
  const value = (e: Expr, what: string) => valueTs(e, target, what);
  switch (r.kind) {
    case "object":
      return `client.get(${q(r.type)}, ${value(r.id, "the object's id")}${r.provenance ? ", { provenance: true }" : ""})`;
    case "related":
      return `client.related(${q(r.type)}, ${value(r.of, "the object's id")}, ${q(r.relationship)})`;
    case "aggregate": {
      const a = r.aggregate;
      const filter = a.filter ? `, filter: ${filterJson(a.filter, target)}` : "";
      const groupBy = a.groupBy?.length ? `, groupBy: ${JSON.stringify(a.groupBy)}` : "";
      return `client.aggregate({ type: ${q(a.type)}${filter}${groupBy}, aggregations: ${JSON.stringify(a.aggregations)} }).then((r) => r.groups)`;
    }
    case "query":
      return `rows(${queryTs(r.query, target)}, ${JSON.stringify({ ...(r.query.all ? { all: true } : {}), ...(r.query.limit !== undefined ? { limit: r.query.limit } : {}) })})`;
  }
}

/** An expression a read takes as a value: a literal as it is, anything else `need`ed. */
export function valueTs(e: Expr, target: ExprTarget, what: string): string {
  if (e === null || typeof e === "number" || typeof e === "boolean" || isLiteral(e) || (typeof e === "string" && !e.startsWith("$"))) return exprTs(e, target);
  return `need(${exprTs(e, target)}, ${q(typeof e === "string" ? e : what)})`;
}

function queryTs(query: QueryIR, target: ExprTarget): string {
  let s = `client.from(${q(query.type)})`;
  if (query.filter) s += `.where((x) => ${filterTs(query.filter, "x", target)})`;
  if (query.search) s += `.search(${valueTs(query.search.text, target, "the search text")}${query.search.properties ? `, ${JSON.stringify(query.search.properties)}` : ""})`;
  for (const k of query.sort ?? []) s += `.orderBy(${q(k.property)}, ${q(k.direction ?? "asc")})`;
  if (query.select?.length) s += `.select(${query.select.map(q).join(", ")})`;
  for (const inc of query.include ?? []) s += includeTs(inc, target);
  if (query.limit !== undefined && !query.all) s += `.limit(${query.limit})`;
  return s;
}

function includeTs(inc: IncludeIR, target: ExprTarget): string {
  let body = "i";
  if (inc.select?.length) body += `.select(${inc.select.map(q).join(", ")})`;
  if (inc.filter) body += `.where((x) => ${filterTs(inc.filter, "x", target)})`;
  for (const k of inc.sort ?? []) body += `.orderBy(${q(k.property)}, ${q(k.direction ?? "asc")})`;
  if (inc.limit !== undefined) body += `.limit(${inc.limit})`;
  for (const nested of inc.include ?? []) body += includeTs(nested, target);
  return body === "i" ? `.include(${q(inc.relationship)})` : `.include(${q(inc.relationship)}, (i) => ${body})`;
}

/** A filter with the SDK's typed field references: `x.condition.eq("poor")`, `and(…)`. */
function filterTs(f: FilterIR, x: string, target: ExprTarget): string {
  if ("and" in f) return `and(${f.and.map((p) => filterTs(p, x, target)).join(", ")})`;
  if ("or" in f) return `or(${f.or.map((p) => filterTs(p, x, target)).join(", ")})`;
  const field = /^[A-Za-z_$][\w$]*$/.test(f.property) ? `${x}.${f.property}` : `${x}[${q(f.property)}]`;
  return `${field}.${f.operator}(${valueTs(f.value, target, `the ${f.property} filter's value`)})`;
}

/** A filter as the runtime's JSON (`aggregate` takes no builder), each expression `need`ed. */
function filterJson(f: FilterIR, target: ExprTarget): string {
  if ("and" in f) return `{ and: [${f.and.map((p) => filterJson(p, target)).join(", ")}] }`;
  if ("or" in f) return `{ or: [${f.or.map((p) => filterJson(p, target)).join(", ")}] }`;
  return `{ property: ${q(f.property)}, operator: ${q(f.operator)}, value: ${valueTs(f.value, target, `the ${f.property} filter's value`)} }`;
}

/** Whether a read's TypeScript uses the SDK's `and`/`or`. */
export function usesCombinators(r: ReadIR): { and: boolean; or: boolean } {
  const text = JSON.stringify(r.kind === "query" ? r.query : {});
  return { and: text.includes('"and":'), or: text.includes('"or":') };
}

export { ident };
