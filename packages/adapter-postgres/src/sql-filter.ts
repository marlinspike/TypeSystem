import type { QueryCondition, QueryFilter } from "@typesys/core";
import { exactDecimal, nextDown, nextUp } from "./double.js";

/**
 * The filter DSL compiled to a predicate over the `values` JSONB column
 * (ADR-0040). Each piece is either *exact* — it selects exactly the rows
 * `matchesFilter` would — or a *superset* of them; the adapter re-checks every
 * row it reads with `matchesFilter`, so a superset is only ever narrowed. SQL
 * that excluded a row `matchesFilter` keeps would hide data, so every
 * predicate is written to fail toward inclusion.
 */
export interface CompiledFilter {
  sql: string;
  exact: boolean;
}

/** Binds values as positional parameters, appended after any the caller already bound. */
export class SqlParams {
  constructor(readonly values: unknown[] = []) {}
  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const TRUE: CompiledFilter = { sql: "TRUE", exact: true };
const FALSE: CompiledFilter = { sql: "FALSE", exact: true };

/** A value JSONB equality compares as JavaScript's `===` does: a string, a boolean, or `null`. */
const isContainable = (v: unknown): v is string | boolean | null => v === null || typeof v === "string" || typeof v === "boolean";
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Never NULL: a missing property makes a comparison NULL in SQL, and `NOT NULL` would drop a row `!==` keeps. */
const definite = (sql: string): string => `COALESCE((${sql}), FALSE)`;

function jsonType(params: SqlParams, property: string, type: string): string {
  return `jsonb_typeof(values -> ${params.bind(property)}) = '${type}'`;
}

/**
 * A stored number compared, in exact `numeric` arithmetic, with the exact
 * decimal value of a double (ADR-0044): `op` is `>` or `<`. JavaScript reads
 * the stored decimal `x` as `round(x)`, and rounding is monotone, so these
 * bounds follow from the double's neighbors without trusting anyone's
 * floating-point parser. An infinite bound is no bound at all.
 */
function numberBound(params: SqlParams, property: string, op: ">" | "<", bound: number): string {
  return Number.isFinite(bound) ? ` AND (values ->> ${params.bind(property)})::numeric ${op} ${params.bind(exactDecimal(bound))}::numeric` : "";
}

/** Numbers only, narrowed by exact bounds: a superset, since the stored decimal is not the double JavaScript sees. */
function numbers(params: SqlParams, property: string, lower: number | undefined, upper: number | undefined): CompiledFilter {
  const sql = `${jsonType(params, property, "number")}${lower === undefined ? "" : numberBound(params, property, ">", lower)}${upper === undefined ? "" : numberBound(params, property, "<", upper)}`;
  return { sql: definite(sql), exact: false };
}

function equals(params: SqlParams, property: string, value: unknown): CompiledFilter {
  // `@>` against {"p": v} holds exactly when p is present and equal — and uses the GIN index.
  if (isContainable(value)) return { sql: `values @> ${params.bind(JSON.stringify({ [property]: value }))}::jsonb`, exact: true };
  // round(x) = v only for x strictly between v's neighbors.
  if (isFiniteNumber(value)) return numbers(params, property, nextDown(value), nextUp(value));
  // `===` against a fresh array or object, NaN, or an infinity never holds.
  return FALSE;
}

/** `!==`: only a stored number exactly equal to `v` is sure to read back as `v`, so only those rows can be ruled out. */
function differs(params: SqlParams, property: string, value: unknown): CompiledFilter {
  if (isContainable(value)) return { sql: `NOT ${definite(equals(params, property, value).sql)}`, exact: true };
  if (isFiniteNumber(value)) {
    const exactly = `${jsonType(params, property, "number")} AND (values ->> ${params.bind(property)})::numeric = ${params.bind(exactDecimal(value))}::numeric`;
    return { sql: `NOT ${definite(exactly)}`, exact: false };
  }
  return TRUE;
}

function condition(params: SqlParams, c: QueryCondition): CompiledFilter {
  const { property, value } = c;
  switch (c.operator) {
    case "eq":
      return equals(params, property, value);
    case "ne":
      return differs(params, property, value);
    case "in": {
      if (!Array.isArray(value)) return FALSE;
      const each = value.map((v) => equals(params, property, v)).filter((e) => e !== FALSE);
      return each.length === 0 ? FALSE : { sql: `(${each.map((e) => definite(e.sql)).join(" OR ")})`, exact: each.every((e) => e.exact) };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof value !== "number" || Number.isNaN(value)) return FALSE;
      // An infinite bound: JavaScript compares it fine; leave it to the re-check, narrowed to numbers.
      if (!Number.isFinite(value)) return numbers(params, property, undefined, undefined);
      // round(x) > v ⇒ x > v; round(x) ≥ v ⇒ x > v⁻; round(x) < v ⇒ x < v; round(x) ≤ v ⇒ x < v⁺.
      if (c.operator === "gt") return numbers(params, property, value, undefined);
      if (c.operator === "gte") return numbers(params, property, nextDown(value), undefined);
      if (c.operator === "lt") return numbers(params, property, undefined, value);
      return numbers(params, property, undefined, nextUp(value));
    }
    // JSONB array containment and Postgres case folding don't match JavaScript's: narrow by type, re-check in JS.
    case "contains":
      return { sql: definite(jsonType(params, property, "array")), exact: false };
    case "icontains":
      return typeof value === "string" ? { sql: definite(jsonType(params, property, "string")), exact: false } : FALSE;
    default:
      // matchesFilter matches nothing for an operator it doesn't know.
      return FALSE;
  }
}

export function compileFilter(filter: QueryFilter, params: SqlParams): CompiledFilter {
  if ("and" in filter) {
    const parts = filter.and.map((f) => compileFilter(f, params));
    return parts.length === 0 ? TRUE : { sql: `(${parts.map((p) => p.sql).join(" AND ")})`, exact: parts.every((p) => p.exact) };
  }
  if ("or" in filter) {
    const parts = filter.or.map((f) => compileFilter(f, params));
    return parts.length === 0 ? FALSE : { sql: `(${parts.map((p) => p.sql).join(" OR ")})`, exact: parts.every((p) => p.exact) };
  }
  return condition(params, filter);
}
