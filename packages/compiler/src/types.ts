import type { JsonSchema2020, TypeDescription } from "@typesys/core";

/**
 * The checker's types (ADR-0080): the JSON values an application handles,
 * as precise as the model's schemas say and no more. `unknown` is any JSON
 * value, which the checker lets through only where any value will do.
 */
export type Ty =
  | { readonly t: "string"; readonly enum?: readonly string[]; readonly format?: string }
  | { readonly t: "number"; readonly integer?: boolean }
  | { readonly t: "boolean" }
  | { readonly t: "null" }
  | { readonly t: "list"; readonly of: Ty }
  | { readonly t: "object"; readonly fields: Readonly<Record<string, Field>>; readonly semantic?: string; readonly open?: boolean }
  | { readonly t: "unknown" };

/** An object's field: its type, and whether it can be absent. */
export interface Field {
  readonly ty: Ty;
  /** The runtime may withhold it from a caller (policy, classification), or the source may not hold it. */
  readonly optional: boolean;
}

/**
 * A value's type and why it may be unknown. `withheld`: the runtime may
 * withhold it from this caller; `skippedBy`: these steps may be skipped,
 * leaving it unknown; `nullable`: it may be JSON `null`.
 */
export interface Typed {
  readonly ty: Ty;
  readonly withheld?: boolean;
  readonly skippedBy?: readonly string[];
  readonly nullable?: boolean;
}

export const STRING: Ty = { t: "string" };
export const NUMBER: Ty = { t: "number" };
export const INTEGER: Ty = { t: "number", integer: true };
export const BOOLEAN: Ty = { t: "boolean" };
export const UNKNOWN: Ty = { t: "unknown" };
export const known = (ty: Ty): Typed => ({ ty });

/** Whether a typed value may be unknown when it is used: withheld, skipped, or null. */
export const mayBeUnknown = (v: Typed): boolean => v.withheld === true || (v.skippedBy?.length ?? 0) > 0 || v.nullable === true;

/** The union of several values' unknowns, onto `ty`. */
export function carrying(ty: Ty, ...from: readonly Typed[]): Typed {
  const skipped = [...new Set(from.flatMap((f) => f.skippedBy ?? []))];
  return {
    ty,
    ...(from.some((f) => f.withheld) ? { withheld: true } : {}),
    ...(skipped.length ? { skippedBy: skipped } : {}),
    ...(from.some((f) => f.nullable) ? { nullable: true } : {})
  };
}

/** A JSON Schema as a checker type. Anything it cannot read precisely (a `$ref`, a union) is `unknown`, never a guess. */
export function schemaToTy(schema: JsonSchema2020 | undefined): { ty: Ty; nullable: boolean } {
  if (schema === undefined || typeof schema === "boolean") return { ty: UNKNOWN, nullable: false };
  if (schema.const !== undefined) return literalTy(schema.const);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    const nullable = values.includes(null);
    const rest = values.filter((v) => v !== null);
    if (rest.length > 0 && rest.every((v) => typeof v === "string")) return { ty: { t: "string", enum: rest }, nullable };
    if (rest.length > 0 && rest.every((v) => typeof v === "number")) return { ty: NUMBER, nullable };
    if (rest.length > 0 && rest.every((v) => typeof v === "boolean")) return { ty: BOOLEAN, nullable };
    return { ty: UNKNOWN, nullable };
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const parts = variants.map((v) => schemaToTy(v));
    const nonNull = parts.filter((p) => p.ty.t !== "null");
    const nullable = parts.some((p) => p.nullable || p.ty.t === "null");
    if (nonNull.length === 1) return { ty: nonNull[0]!.ty, nullable };
    return { ty: UNKNOWN, nullable };
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes("null");
  const kinds = types.filter((t) => t !== "null");
  if (kinds.length !== 1) return { ty: UNKNOWN, nullable };
  switch (kinds[0]) {
    case "string":
      return { ty: typeof schema.format === "string" ? { t: "string", format: schema.format } : STRING, nullable };
    case "integer":
      return { ty: INTEGER, nullable };
    case "number":
      return { ty: NUMBER, nullable };
    case "boolean":
      return { ty: BOOLEAN, nullable };
    case "array":
      return { ty: { t: "list", of: schemaToTy(schema.items).ty }, nullable };
    case "object": {
      const props = (schema.properties ?? {});
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const fields: Record<string, Field> = {};
      for (const [k, s] of Object.entries(props)) {
        const f = schemaToTy(s);
        fields[k] = { ty: f.ty, optional: !required.has(k) || f.nullable };
      }
      return { ty: { t: "object", fields, open: schema.additionalProperties !== false && Object.keys(props).length === 0 }, nullable };
    }
    default:
      return { ty: UNKNOWN, nullable };
  }
}

/** The type of a JSON literal, as precise as it is: `"open"` is a string that is exactly `"open"`. */
export function literalTy(value: unknown): { ty: Ty; nullable: boolean } {
  if (value === null) return { ty: { t: "null" }, nullable: true };
  if (typeof value === "string") return { ty: { t: "string", enum: [value] }, nullable: false };
  if (typeof value === "number") return { ty: Number.isInteger(value) ? INTEGER : NUMBER, nullable: false };
  if (typeof value === "boolean") return { ty: BOOLEAN, nullable: false };
  if (Array.isArray(value)) {
    const items = value.map((v) => literalTy(v).ty);
    const of = items.reduce<Ty | undefined>((acc, t) => (acc === undefined ? widen(t) : join(acc, t) ?? UNKNOWN), undefined) ?? UNKNOWN;
    return { ty: { t: "list", of }, nullable: false };
  }
  if (typeof value === "object") {
    const fields: Record<string, Field> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = { ty: literalTy(v).ty, optional: false };
    return { ty: { t: "object", fields }, nullable: false };
  }
  return { ty: UNKNOWN, nullable: false };
}

/** A literal's type, without its exact value: `"open"` as a string. */
export function widen(ty: Ty): Ty {
  if (ty.t === "string" && ty.enum && ty.enum.length === 1) return ty.format ? { t: "string", format: ty.format } : STRING;
  return ty;
}

/** The one type both values have, if they have one: two enums join as their union. */
export function join(a: Ty, b: Ty): Ty | undefined {
  if (a.t === "unknown" || b.t === "unknown") return UNKNOWN;
  if (a.t !== b.t) return undefined;
  switch (a.t) {
    case "string": {
      const bs = b as Extract<Ty, { t: "string" }>;
      if (a.enum && bs.enum) return { t: "string", enum: [...new Set([...a.enum, ...bs.enum])] };
      return a.format && a.format === bs.format ? { t: "string", format: a.format } : STRING;
    }
    case "number":
      return { t: "number", ...(a.integer && (b as Extract<Ty, { t: "number" }>).integer ? { integer: true } : {}) };
    case "list": {
      const of = join(a.of, (b as Extract<Ty, { t: "list" }>).of);
      return of ? { t: "list", of } : undefined;
    }
    case "object":
      return a.semantic && a.semantic === (b as Extract<Ty, { t: "object" }>).semantic ? a : { t: "object", fields: {}, open: true };
    default:
      return a;
  }
}

/**
 * Whether a value of `from` may be given where `to` is expected, and if not,
 * why: the checker's answer for an Action's input, a flow's input and a
 * component's props. Nothing is coerced: an integer is a number, but a
 * number is not an integer, and a string is not an enum.
 */
export function assignable(from: Ty, to: Ty): string | undefined {
  if (to.t === "unknown" || from.t === "unknown") return undefined;
  if (from.t !== to.t) return `${describe(from)} is not ${describe(to)}`;
  switch (to.t) {
    case "string": {
      const f = from as Extract<Ty, { t: "string" }>;
      if (to.enum) {
        if (!f.enum) return `a string is not one of ${to.enum.map((e) => JSON.stringify(e)).join(", ")}`;
        const outside = f.enum.filter((e) => !to.enum!.includes(e));
        if (outside.length) return `${outside.map((e) => JSON.stringify(e)).join(", ")} ${outside.length === 1 ? "is" : "are"} not one of ${to.enum.map((e) => JSON.stringify(e)).join(", ")}`;
      }
      return undefined;
    }
    case "number":
      return to.integer && !(from as Extract<Ty, { t: "number" }>).integer ? "a number is not an integer" : undefined;
    case "list":
      return assignable((from as Extract<Ty, { t: "list" }>).of, to.of);
    case "object": {
      const f = from as Extract<Ty, { t: "object" }>;
      for (const [k, field] of Object.entries(to.fields)) {
        const got = f.fields[k];
        if (!got) {
          if (!field.optional && !f.open) return `it has no field "${k}"`;
          continue;
        }
        const why = assignable(got.ty, field.ty);
        if (why) return `field "${k}": ${why}`;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A type in words, for a diagnostic. */
export function describe(ty: Ty): string {
  switch (ty.t) {
    case "string":
      return ty.enum ? (ty.enum.length === 1 ? JSON.stringify(ty.enum[0]) : `one of ${ty.enum.map((e) => JSON.stringify(e)).join(", ")}`) : ty.format ? `a ${ty.format} string` : "a string";
    case "number":
      return ty.integer ? "an integer" : "a number";
    case "boolean":
      return "a boolean";
    case "null":
      return "null";
    case "list":
      return `a list of ${describe(ty.of).replace(/^an? /, "")}`;
    case "object":
      return ty.semantic ? `a ${ty.semantic}` : "an object";
    case "unknown":
      return "any value";
  }
}

/** The TypeScript type of a checker type, for a generated contract a handwritten extension must satisfy. */
export function tsType(ty: Ty): string {
  switch (ty.t) {
    case "string":
      return ty.enum ? ty.enum.map((e) => JSON.stringify(e)).join(" | ") : "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "list":
      return `readonly (${tsType(ty.of)})[]`;
    case "object": {
      const entries = Object.entries(ty.fields).map(([k, f]) => `readonly ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${f.optional ? "?" : ""}: ${tsType(f.ty)}`);
      if (ty.open) entries.push("readonly [key: string]: unknown");
      return `{ ${entries.join("; ")} }`;
    }
    case "unknown":
      return "unknown";
  }
}

/** The TypeScript type of a typed value, `undefined` included when it may be unknown. */
export function tsTypeOf(v: Typed): string {
  const base = tsType(v.ty);
  const extra = [...(v.nullable ? ["null"] : []), ...(v.withheld || v.skippedBy?.length ? ["undefined"] : [])];
  return extra.length ? `${base} | ${extra.join(" | ")}` : base;
}

/** What a read returns for each object of a Type: its id and Type, and each value it selects, each of which the runtime may withhold. */
export function rowTy(type: TypeDescription, select: readonly string[] | undefined, includes: Readonly<Record<string, Ty>> = {}): Extract<Ty, { t: "object" }> {
  const fields: Record<string, Field> = { $id: { ty: STRING, optional: false }, $type: { ty: { t: "string", enum: [type.name] }, optional: false } };
  const wanted = select ? new Set(select) : undefined;
  for (const [k, s] of Object.entries(type.properties)) if (!wanted || wanted.has(k)) fields[k] = { ty: schemaToTy(s).ty, optional: true };
  for (const c of type.computed) if (!wanted || wanted.has(c.name)) fields[c.name] = { ty: schemaToTy(c.schema).ty, optional: true };
  for (const [k, t] of Object.entries(includes)) fields[k] = { ty: t, optional: false };
  // An optional relationship whose source failed is named here, with why (ADR-0072).
  fields.$unavailable = { ty: { t: "list", of: { t: "object", fields: { path: { ty: STRING, optional: false }, reason: { ty: { t: "string", enum: ["unavailable", "timeout", "refused-by-source"] }, optional: false }, message: { ty: STRING, optional: false } } } }, optional: true };
  return { t: "object", fields, semantic: type.name };
}

/** An aggregate group: a key per `groupBy` property, a number per aggregation. */
export function groupTy(type: TypeDescription, groupBy: readonly string[], aggregations: readonly string[]): Ty {
  const key: Record<string, Field> = {};
  for (const g of groupBy) key[g] = { ty: schemaToTy(type.properties[g]).ty, optional: true };
  const values: Record<string, Field> = {};
  for (const a of aggregations) values[a] = { ty: NUMBER, optional: false };
  return { t: "object", fields: { key: { ty: { t: "object", fields: key }, optional: false }, values: { ty: { t: "object", fields: values }, optional: false } } };
}
