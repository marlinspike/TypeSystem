import type { QueryCondition, QueryFilter, SortKey } from "@typesys/core";
import { exactDecimal, nextDown, nextUp } from "./double.js";
import { SqlParams } from "./sql-filter.js";

/**
 * What a column's catalog type is, as far as pushing a condition or an
 * order into SQL is concerned (ADR-0122). Anything not named is `other`:
 * read and re-checked, never compared in SQL.
 */
export type ColumnKind = "text" | "bpchar" | "int" | "int8" | "numeric" | "float" | "bool" | "uuid" | "date" | "timestamp" | "timestamptz" | "other";

const KINDS: Readonly<Record<string, ColumnKind>> = {
  text: "text",
  varchar: "text",
  name: "text",
  bpchar: "bpchar",
  int2: "int",
  int4: "int",
  int8: "int8",
  numeric: "numeric",
  float4: "float",
  float8: "float",
  bool: "bool",
  uuid: "uuid",
  date: "date",
  timestamp: "timestamp",
  timestamptz: "timestamptz"
};

/** A catalog base type name (`int4`, `varchar`, a domain's base) as a kind. */
export function kindOf(typname: string | undefined): ColumnKind {
  return (typname !== undefined && Object.hasOwn(KINDS, typname) ? KINDS[typname] : undefined) ?? "other";
}

/** One mapped property's column, with its catalog kind and how its value is read. */
export interface ColumnInfo {
  /** Already quoted. */
  readonly sql: string;
  readonly kind: ColumnKind;
  readonly as?: "text" | "date" | "date-time" | "number" | "integer" | "boolean" | "json";
  readonly mapped: boolean;
}

/** What the value read from a column is in JavaScript: what `matchesFilter` and `compareForSort` see. */
type ValueKind = "string" | "number" | "boolean" | "none";

function valueKind(c: ColumnInfo): ValueKind {
  if (c.mapped) return "none";
  switch (c.as) {
    case "number":
    case "integer":
      return c.kind === "int" || c.kind === "int8" || c.kind === "numeric" || c.kind === "float" ? "number" : "none";
    case "boolean":
      return c.kind === "bool" ? "boolean" : "none";
    case "date":
    case "date-time":
    case "json":
      return "none";
    case "text":
      return c.kind === "text" || c.kind === "bpchar" || c.kind === "int8" || c.kind === "numeric" || c.kind === "uuid" ? "string" : "none";
    default:
      // What the driver returns: int2/int4 and floats as numbers, int8 and numeric as text, booleans as booleans.
      if (c.kind === "int" || c.kind === "float") return "number";
      if (c.kind === "bool") return "boolean";
      if (c.kind === "text" || c.kind === "bpchar" || c.kind === "int8" || c.kind === "numeric" || c.kind === "uuid") return "string";
      return "none";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/**
 * A predicate selecting the rows whose column reads back as exactly `text`
 * (an object id, or the id a foreign key names), written so an index on the
 * column serves it. `undefined`: no row can (a malformed number or uuid).
 * Every row it selects is still checked against `text` by the caller.
 */
export function keyPredicate(c: ColumnInfo, text: string, params: SqlParams): string | undefined {
  switch (c.kind) {
    case "text":
      return `${c.sql} = ${params.bind(text)}::text`;
    case "bpchar":
      // A char(n) compares without its padding, as it is read.
      return `${c.sql} = ${params.bind(text)}::bpchar`;
    case "int":
    case "int8": {
      if (!INTEGER.test(text)) return undefined;
      const n = BigInt(text);
      return n < INT8_MIN || n > INT8_MAX ? undefined : `${c.sql} = ${params.bind(text)}::int8`;
    }
    case "uuid":
      return UUID.test(text) ? `${c.sql} = ${params.bind(text)}::uuid` : undefined;
    default:
      // No index helps a cast; the caller still compares the value read.
      return `${c.sql}::text = ${params.bind(text)}`;
  }
}

/** A compiled piece of a filter: `TRUE` (no narrowing), `FALSE` (no row), or SQL that every matching row satisfies. */
type Piece = { readonly kind: "true" } | { readonly kind: "false" } | { readonly kind: "sql"; readonly sql: string };
const TRUE: Piece = { kind: "true" };
const FALSE: Piece = { kind: "false" };
const sql = (s: string): Piece => ({ kind: "sql", sql: s });

function equals(c: ColumnInfo, value: unknown, params: SqlParams): Piece {
  const vk = valueKind(c);
  if (vk === "none") return TRUE;
  if (vk === "boolean") return typeof value === "boolean" ? sql(`${c.sql} = ${params.bind(value)}::boolean`) : FALSE;
  if (vk === "string") {
    if (typeof value !== "string") return FALSE;
    if (c.kind === "numeric") return TRUE; // "1.10" and "1.1" are one number: left to the re-check.
    const p = keyPredicate(c, value, params);
    return p === undefined ? FALSE : sql(p);
  }
  // A number read back as JavaScript reads it.
  if (typeof value !== "number" || !Number.isFinite(value)) return FALSE;
  return between(c, nextDown(value), nextUp(value), params, true);
}

/**
 * Rows whose value, read as a double, lies strictly between `lo` and `hi`
 * (either may be undefined): for integers, in integer arithmetic so an
 * index serves it; for numeric, against the exact decimal of each bound
 * (ADR-0044). Floats are not narrowed: the driver's reading of a float4
 * is not the stored value.
 */
function between(c: ColumnInfo, lo: number | undefined, hi: number | undefined, params: SqlParams, strict: boolean): Piece {
  if (c.kind === "float") return TRUE;
  const parts: string[] = [];
  if (c.kind === "int" || c.kind === "int8") {
    // Integers x with lo < x < hi: x >= floor(lo) + 1 and x <= ceil(hi) - 1, bounds clamped to int8.
    if (lo !== undefined && Number.isFinite(lo)) {
      const b = BigInt(Math.floor(lo)) + (strict ? 1n : 0n);
      if (b > INT8_MAX) return FALSE;
      if (b > INT8_MIN) parts.push(`${c.sql} >= ${params.bind(b.toString())}::int8`);
    }
    if (hi !== undefined && Number.isFinite(hi)) {
      const b = BigInt(Math.ceil(hi)) - (strict ? 1n : 0n);
      if (b < INT8_MIN) return FALSE;
      if (b < INT8_MAX) parts.push(`${c.sql} <= ${params.bind(b.toString())}::int8`);
    }
  } else if (c.kind === "numeric") {
    // The driver reads x as round(x); rounding is monotone, so round(x) in (lo, hi) implies x in (lo, hi).
    if (lo !== undefined && Number.isFinite(lo)) parts.push(`${c.sql} > ${params.bind(exactDecimal(lo))}::numeric`);
    if (hi !== undefined && Number.isFinite(hi)) parts.push(`${c.sql} < ${params.bind(exactDecimal(hi))}::numeric`);
  } else return TRUE;
  return parts.length === 0 ? TRUE : sql(parts.join(" AND "));
}

function condition(cols: (property: string) => ColumnInfo | undefined, cond: QueryCondition, params: SqlParams): Piece {
  const c = cols(cond.property);
  // A property this source does not map is never present on what it reads: only `ne` holds, and the re-check decides it.
  if (!c) return cond.operator === "ne" ? TRUE : FALSE;
  switch (cond.operator) {
    case "eq":
      return equals(c, cond.value, params);
    case "in": {
      if (!Array.isArray(cond.value)) return FALSE;
      return anyOf(cond.value.map((v) => equals(c, v, params)));
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const v = cond.value;
      if (typeof v !== "number" || Number.isNaN(v)) return FALSE;
      if (valueKind(c) !== "number") return valueKind(c) === "none" ? TRUE : FALSE;
      // round(x) > v implies x > v; round(x) >= v implies x > v⁻; < and <= likewise from above.
      if (cond.operator === "gt") return between(c, v, undefined, params, true);
      if (cond.operator === "gte") return between(c, nextDown(v), undefined, params, true);
      if (cond.operator === "lt") return between(c, undefined, v, params, true);
      return between(c, undefined, nextUp(v), params, true);
    }
    default:
      // ne, contains, icontains: SQL's notions of these differ from JavaScript's; decided by the re-check alone.
      return TRUE;
  }
}

function allOf(parts: Piece[]): Piece {
  if (parts.some((p) => p.kind === "false")) return FALSE;
  const s = parts.filter((p): p is { kind: "sql"; sql: string } => p.kind === "sql");
  return s.length === 0 ? TRUE : sql(s.map((p) => `(${p.sql})`).join(" AND "));
}

function anyOf(parts: Piece[]): Piece {
  if (parts.some((p) => p.kind === "true")) return TRUE;
  const s = parts.filter((p): p is { kind: "sql"; sql: string } => p.kind === "sql");
  return s.length === 0 ? FALSE : sql(s.map((p) => `(${p.sql})`).join(" OR "));
}

/**
 * A filter as a SQL predicate on the table's own columns (ADR-0122): every
 * row `matchesFilter` keeps satisfies it, so it only ever narrows what is
 * read, and every row read is still decided by `matchesFilter`. `"TRUE"`
 * when nothing narrows; `"FALSE"` when no row can match.
 */
export function columnPredicate(filter: QueryFilter | undefined, cols: (property: string) => ColumnInfo | undefined, params: SqlParams): string {
  const compile = (f: QueryFilter): Piece => ("and" in f ? allOf(f.and.map(compile)) : "or" in f ? anyOf(f.or.map(compile)) : condition(cols, f, params));
  const p = filter ? compile(filter) : TRUE;
  return p.kind === "true" ? "TRUE" : p.kind === "false" ? "FALSE" : p.sql;
}

/**
 * `ORDER BY` keys that put rows in the order `applySort` would, or
 * `undefined` when one key cannot be (a mapped, JSON or float column, or a
 * bigint read as a number, whose largest values are not read at all). Missing
 * values sort last ascending and first descending, as `compareForSort`
 * has them; text compares in code-point order (`COLLATE "C"`).
 */
export function orderBy(sort: readonly SortKey[] | undefined, cols: (property: string) => ColumnInfo | undefined): string[] | undefined {
  const out: string[] = [];
  for (const key of sort ?? []) {
    const c = cols(key.property);
    if (!c) continue; // never present: every row ties on it
    const dir = key.direction === "desc" ? "DESC NULLS FIRST" : "ASC NULLS LAST";
    const vk = valueKind(c);
    if (c.mapped || c.as === "json" || c.kind === "float" || c.kind === "other") return undefined;
    if (c.as === "date" || c.as === "date-time") {
      if (c.kind !== "date" && c.kind !== "timestamp" && c.kind !== "timestamptz") return undefined;
      out.push(`${c.sql} ${dir}`);
    } else if (vk === "number" && (c.kind === "int" || c.kind === "numeric")) out.push(`${c.sql} ${dir}`);
    else if (vk === "boolean") out.push(`${c.sql} ${dir}`);
    else if (vk === "string" && (c.kind === "text" || c.kind === "bpchar")) out.push(`${c.sql} COLLATE "C" ${dir}`);
    // Read as text, so ordered as its text is: the driver's text is PostgreSQL's own output for these.
    else if (vk === "string" && (c.kind === "uuid" || c.kind === "int8" || c.kind === "numeric")) out.push(`${c.sql}::text COLLATE "C" ${dir}`);
    else return undefined;
  }
  return out;
}
