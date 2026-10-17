import { didYouMean } from "@typesys/devkit";
import type { JsonSchema2020 } from "@typesys/core";
import { pointer, type Diagnostics } from "./diagnostics.js";
import { EXPR_OPS, type Expr, type ExprOp, type FnCall } from "./ir.js";
import { BOOLEAN, INTEGER, NUMBER, STRING, UNKNOWN, assignable, carrying, describe, join, literalTy, mayBeUnknown, schemaToTy, widen, type Ty, type Typed } from "./types.js";

/** `$head.a.b` → head and path. */
export function parseRef(s: string): { head: string; path: string[] } | undefined {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/.exec(s);
  if (!m) return undefined;
  return { head: m[1]!, path: m[2] ? m[2].slice(1).split(".") : [] };
}

export const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("$");

/** The one operator of an operation object, or why it has none. */
export function operatorOf(e: object): { op: ExprOp } | { op?: undefined; why: string } {
  const keys = Object.keys(e);
  const ops = keys.filter((k): k is ExprOp => (EXPR_OPS as readonly string[]).includes(k));
  if (keys.length !== 1 || ops.length !== 1) return { why: keys.length === 0 ? "an empty object is not an expression" : `${keys.map((k) => JSON.stringify(k)).join(", ")} ${ops.length === 0 ? "is not an operator" : "is more than one key"}` };
  return { op: ops[0]! };
}

export const isFnCall = (e: unknown): e is FnCall => typeof e === "object" && e !== null && !Array.isArray(e) && typeof (e as { fn?: unknown }).fn === "string";
export const isLiteral = (e: unknown): e is { literal: unknown } => typeof e === "object" && e !== null && !Array.isArray(e) && Object.keys(e).length === 1 && "literal" in e;

/** Where an expression is checked: what each `$head` names, and what the position allows. */
export interface Scope {
  /** The value `$head` names here; undefined when nothing does. */
  lookup(head: string): Typed | undefined;
  /** Every name in scope, for a suggestion. */
  names(): readonly string[];
  /** When `$head` names something that exists but may not be used here, why (a later step, an Action's output). */
  refuse?(head: string): { code: string; message: string; hint?: string } | undefined;
  /** `flow` positions are replayed by the engine, so they must be deterministic. */
  readonly mode: "flow" | "ui";
  /** Told of every reference and function call, for the dependency graph and the generated contracts. */
  onRef?(head: string, path: readonly string[]): void;
  onFn?(call: FnCall, args: Readonly<Record<string, Typed>>, at: string): void;
}

/** A scope with more names over another: `$row` in a table, `$item` in a `where`. */
export function extend(scope: Scope, extra: Readonly<Record<string, Typed>>): Scope {
  return {
    mode: scope.mode,
    lookup: (head) => (Object.hasOwn(extra, head) ? extra[head] : scope.lookup(head)),
    names: () => [...Object.keys(extra), ...scope.names()],
    ...(scope.refuse ? { refuse: (h: string) => (Object.hasOwn(extra, h) ? undefined : scope.refuse!(h)) } : {}),
    ...(scope.onRef ? { onRef: scope.onRef.bind(scope) } : {}),
    ...(scope.onFn ? { onFn: scope.onFn.bind(scope) } : {})
  };
}

const ARITY: Partial<Record<ExprOp, [number, number]>> = {
  eq: [2, 2], ne: [2, 2], lt: [2, 2], lte: [2, 2], gt: [2, 2], gte: [2, 2], in: [2, 2],
  and: [2, 64], or: [2, 64], if: [3, 3], coalesce: [2, 16],
  add: [2, 16], sub: [2, 2], mul: [2, 16], div: [2, 2], round: [1, 2], concat: [2, 32],
  sum: [1, 2], avg: [1, 2], min: [1, 2], max: [1, 2], where: [2, 2], pluck: [2, 2]
};

const unknownOf = (...from: Typed[]): Typed => carrying(UNKNOWN, ...from);

/**
 * Types an expression in a scope, reporting every problem (ADR-0080).
 * Returns the expression's type; after an error, `unknown`, so one mistake
 * is reported once rather than at every use.
 */
export function checkExpr(e: unknown, scope: Scope, at: string, d: Diagnostics): Typed {
  if (e === null) return { ty: { t: "null" }, nullable: true };
  if (typeof e === "number") return { ty: Number.isInteger(e) ? INTEGER : NUMBER };
  if (typeof e === "boolean") return { ty: BOOLEAN };
  if (typeof e === "string") {
    if (!e.startsWith("$")) return { ty: literalTy(e).ty };
    return checkRef(e, scope, at, d);
  }
  if (Array.isArray(e)) {
    const items = e.map((x, i) => checkExpr(x as Expr, scope, `${at}/${i}`, d));
    let of: Ty | undefined;
    for (const [i, it] of items.entries()) {
      const next: Ty | undefined = of === undefined ? widen(it.ty) : join(of, it.ty);
      if (next === undefined) {
        d.error("type-mismatch", `${at}/${i}`, `a list's elements must have one type: ${describe(it.ty)} is not ${describe(of!)}`);
        return { ty: { t: "list", of: UNKNOWN } };
      }
      of = next;
    }
    return carrying({ t: "list", of: of ?? UNKNOWN }, ...items);
  }
  if (typeof e !== "object") {
    d.error("invalid-app", at, "an expression is a literal, a $reference, a list or an operation");
    return { ty: UNKNOWN };
  }
  if (isLiteral(e)) return { ty: literalTy(e.literal).ty, ...(e.literal === null ? { nullable: true } : {}) };
  if (isFnCall(e)) return checkFn(e, scope, at, d);
  const found = operatorOf(e);
  if (!found.op) {
    d.error("unknown-operator", at, `not an expression: ${found.why}`, `operators: ${EXPR_OPS.join(", ")}; a JSON value is { "literal": … }`);
    return { ty: UNKNOWN };
  }
  const op = found.op;
  const raw = (e as Record<string, unknown>)[op];
  const opAt = `${at}/${op}`;
  // `not`, `exists`, `count` and `hoursSince` take one operand; the rest take a list of them.
  if (op === "not" || op === "exists" || op === "count" || op === "hoursSince") {
    const v = checkExpr(raw, scope, opAt, d);
    if (op === "exists") return { ty: BOOLEAN };
    if (op === "not") {
      expect(v, BOOLEAN, opAt, d);
      return carrying(BOOLEAN, v);
    }
    if (op === "count") {
      if (v.ty.t !== "list" && v.ty.t !== "unknown") d.error("list-expected", opAt, `count takes a list, and this is ${describe(v.ty)}`);
      return carrying(INTEGER, v);
    }
    if (scope.mode === "flow") d.error("nondeterministic-in-flow", at, "hoursSince reads the clock, which differs on replay", "compute the age in the interface, or pass the time as a flow input");
    if (!(v.ty.t === "string" && (v.ty.format === "date-time" || v.ty.format === "date")) && v.ty.t !== "unknown") d.error("type-mismatch", opAt, `hoursSince takes a date-time string, and this is ${describe(v.ty)}`);
    return carrying(NUMBER, v);
  }
  if (!Array.isArray(raw)) {
    d.error("arity", opAt, `${op} takes a list of operands`);
    return { ty: UNKNOWN };
  }
  const [lo, hi] = ARITY[op] ?? [1, 64];
  if (raw.length < lo || raw.length > hi) {
    d.error("arity", opAt, `${op} takes ${lo === hi ? lo : `${lo} to ${hi}`} operands, not ${raw.length}`);
    return { ty: UNKNOWN };
  }
  // `where` binds $item for its predicate; `pluck` and the aggregates take a field name, not an expression.
  if (op === "where" || op === "pluck" || ((op === "sum" || op === "avg" || op === "min" || op === "max") && raw.length === 2)) {
    const list = checkExpr(raw[0] as Expr, scope, `${opAt}/0`, d);
    const item: Ty = list.ty.t === "list" ? list.ty.of : UNKNOWN;
    if (list.ty.t !== "list" && list.ty.t !== "unknown") {
      d.error("list-expected", `${opAt}/0`, `${op} takes a list first, and this is ${describe(list.ty)}`);
      return unknownOf(list);
    }
    if (op === "where") {
      const pred = checkExpr(raw[1] as Expr, extend(scope, { item: { ty: item } }), `${opAt}/1`, d);
      expect(pred, BOOLEAN, `${opAt}/1`, d);
      return carrying(list.ty, list);
    }
    const name: unknown = raw[1];
    if (typeof name !== "string" || name.startsWith("$")) {
      d.error("type-mismatch", `${opAt}/1`, `${op} takes the name of a field of each element, as a plain string`);
      return unknownOf(list);
    }
    const field = item.t === "object" ? item.fields[name] : undefined;
    if (item.t === "object" && !field && !item.open) {
      const near = didYouMean(name, Object.keys(item.fields));
      d.error("unknown-field", `${opAt}/1`, `the elements have no field "${name}"`, near ? `did you mean "${near}"?` : `fields: ${Object.keys(item.fields).filter((f) => !f.startsWith("$")).join(", ")}`);
      return unknownOf(list);
    }
    const fty = field?.ty ?? UNKNOWN;
    if (op === "pluck") return carrying({ t: "list", of: fty }, list);
    if (fty.t !== "number" && fty.t !== "unknown") d.error("type-mismatch", `${opAt}/1`, `${op} adds up numbers, and "${name}" is ${describe(fty)}`);
    // A field the runtime may withhold from one element makes the total unknown, not the total of the rest.
    return { ...carrying(op === "sum" ? NUMBER : fty.t === "number" ? fty : NUMBER, list), ...(op === "sum" ? {} : { nullable: true }), ...(field?.optional ? { withheld: true } : {}) };
  }
  const args = raw.map((x, i) => checkExpr(x as Expr, scope, `${opAt}/${i}`, d));
  switch (op) {
    case "eq":
    case "ne": {
      comparable(args[0]!, args[1]!, opAt, d, false);
      return carrying(BOOLEAN, ...args);
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      comparable(args[0]!, args[1]!, opAt, d, true);
      return carrying(BOOLEAN, ...args);
    }
    case "in": {
      const [v, list] = args as [Typed, Typed];
      if (list.ty.t !== "list" && list.ty.t !== "unknown") d.error("list-expected", `${opAt}/1`, `in looks in a list, and this is ${describe(list.ty)}`);
      else if (list.ty.t === "list") comparable(v, { ty: list.ty.of }, opAt, d, false);
      return carrying(BOOLEAN, ...args);
    }
    case "and":
    case "or":
      args.forEach((a, i) => expect(a, BOOLEAN, `${opAt}/${i}`, d));
      return carrying(BOOLEAN, ...args);
    case "if": {
      expect(args[0]!, BOOLEAN, `${opAt}/0`, d);
      const ty = join(args[1]!.ty, args[2]!.ty);
      if (!ty) {
        d.error("type-mismatch", opAt, `the two branches of if have different types: ${describe(args[1]!.ty)} and ${describe(args[2]!.ty)}`);
        return unknownOf(...args);
      }
      return carrying(ty, args[1]!, args[2]!);
    }
    case "coalesce": {
      let ty: Ty | undefined = args[0]!.ty;
      for (const [i, a] of args.entries()) {
        if (a.ty.t === "null") continue;
        const next: Ty | undefined = ty.t === "null" ? a.ty : join(ty, a.ty);
        if (!next) {
          d.error("type-mismatch", `${opAt}/${i}`, `coalesce's values must have one type: ${describe(a.ty)} is not ${describe(ty)}`);
          return unknownOf(...args);
        }
        ty = next;
      }
      // Known as soon as its last value is.
      return { ...carrying(ty, args[args.length - 1]!) };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      args.forEach((a, i) => expect(a, NUMBER, `${opAt}/${i}`, d));
      const integer = op !== "div" && args.every((a) => a.ty.t === "number" && a.ty.integer);
      return carrying(integer ? INTEGER : NUMBER, ...args);
    }
    case "round": {
      expect(args[0]!, NUMBER, `${opAt}/0`, d);
      if (raw.length === 2 && !(typeof raw[1] === "number" && Number.isInteger(raw[1]) && raw[1] >= 0 && raw[1] <= 10)) d.error("type-mismatch", `${opAt}/1`, "round's digits are a whole number from 0 to 10, written as a literal");
      return carrying(raw.length === 1 || raw[1] === 0 ? INTEGER : NUMBER, args[0]!);
    }
    case "concat":
      args.forEach((a, i) => {
        if (a.ty.t !== "string" && a.ty.t !== "number" && a.ty.t !== "unknown") d.error("type-mismatch", `${opAt}/${i}`, `concat joins strings and numbers, and this is ${describe(a.ty)}`);
      });
      return carrying(STRING, ...args);
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const list = args[0]!;
      if (list.ty.t !== "list" && list.ty.t !== "unknown") {
        d.error("list-expected", `${opAt}/0`, `${op} takes a list, and this is ${describe(list.ty)}`);
        return unknownOf(list);
      }
      const of = list.ty.t === "list" ? list.ty.of : UNKNOWN;
      if (of.t !== "number" && of.t !== "unknown") d.error("type-mismatch", `${opAt}/0`, `${op} of a list of ${describe(of).replace(/^an? /, "")}: give the field to add up as a second operand`);
      return { ...carrying(op === "sum" ? NUMBER : of.t === "number" ? of : NUMBER, list), ...(op === "sum" ? {} : { nullable: true }) };
    }
    default:
      d.error("unknown-operator", opAt, `${String(op)} is not handled here`);
      return unknownOf(...args);
  }
}

function checkRef(s: string, scope: Scope, at: string, d: Diagnostics): Typed {
  const ref = parseRef(s);
  if (!ref) {
    d.error("invalid-reference", at, `"${s}" is not a reference`, 'write $scope.field (letters, digits and _), or { "literal": "…" } for a string that starts with $');
    return { ty: UNKNOWN };
  }
  const refused = scope.refuse?.(ref.head);
  if (refused) {
    d.error(refused.code, at, refused.message, refused.hint);
    return { ty: UNKNOWN };
  }
  const root = scope.lookup(ref.head);
  if (!root) {
    const near = didYouMean(ref.head, scope.names());
    d.error("unknown-reference", at, `"$${ref.head}" names nothing here`, near ? `did you mean "$${near}"?` : `in scope: ${scope.names().map((n) => `$${n}`).join(", ") || "nothing"}`);
    return { ty: UNKNOWN };
  }
  scope.onRef?.(ref.head, ref.path);
  return walk(root, ref.path, `$${ref.head}`, at, d);
}

/** Follows a path into a typed value: fields of objects, never into a list. */
export function walk(root: Typed, path: readonly string[], shown: string, at: string, d: Diagnostics): Typed {
  let cur = root;
  let name = shown;
  for (const seg of path) {
    const ty = cur.ty;
    if (ty.t === "unknown") return cur;
    if (ty.t === "list") {
      d.error("list-path", at, `${name} is a list, so it has no field "${seg}"`, `use { "pluck": ["${name}", "${seg}"] } for the list of them, or { "count": "${name}" }`);
      return { ty: UNKNOWN };
    }
    if (ty.t !== "object") {
      d.error("unknown-field", at, `${name} is ${describe(ty)}, which has no field "${seg}"`);
      return { ty: UNKNOWN };
    }
    const field = ty.fields[seg];
    if (!field) {
      if (ty.open) return carrying(UNKNOWN, cur);
      const fields = Object.keys(ty.fields).filter((f) => !f.startsWith("$") || f === "$id");
      const near = didYouMean(seg, fields);
      d.error("unknown-field", at, `${name}${ty.semantic ? ` (${ty.semantic})` : ""} has no field "${seg}"`, near ? `did you mean "${near}"?` : `its fields are ${fields.join(", ")}`);
      return { ty: UNKNOWN };
    }
    // A field of an object the runtime returned may be withheld from this caller; of any other object, absent.
    const semantic = ty.semantic !== undefined;
    cur = {
      ty: field.ty,
      ...(cur.withheld || (field.optional && semantic) ? { withheld: true } : {}),
      ...(cur.skippedBy?.length ? { skippedBy: cur.skippedBy } : {}),
      ...(cur.nullable || (field.optional && !semantic) ? { nullable: true } : {})
    };
    name = `${name}.${seg}`;
  }
  return cur;
}

function checkFn(call: FnCall, scope: Scope, at: string, d: Diagnostics): Typed {
  if (!/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*#[A-Za-z_][A-Za-z0-9_]*$/.test(call.fn)) d.error("invalid-app", `${at}/fn`, `"${call.fn}" is not <module>#<export>`, 'e.g. "stability#remainingBudget", the module in src/extensions/');
  const args: Record<string, Typed> = {};
  if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) d.error("invalid-app", `${at}/args`, "fn args are an object of named expressions");
  else for (const [k, v] of Object.entries(call.args)) args[k] = checkExpr(v, scope, `${at}/args/${k}`, d);
  if (call.returns === undefined) d.error("invalid-app", `${at}/returns`, "a fn call declares what it returns, as JSON Schema", "the generated contract the function must satisfy is built from it");
  scope.onFn?.(call, args, at);
  const r = schemaToTy(call.returns);
  return carrying(r.ty, ...Object.values(args));
}

function expect(v: Typed, want: Ty, at: string, d: Diagnostics): void {
  const why = assignable(v.ty, want);
  if (why) d.error("type-mismatch", at, `expected ${describe(want)}: ${why}`);
}

/** Two values that may be compared: one type (an integer with a number), and for ordering, numbers or dates. */
function comparable(a: Typed, b: Typed, at: string, d: Diagnostics, ordered: boolean): void {
  const [x, y] = [a.ty, b.ty];
  if (x.t === "unknown" || y.t === "unknown") return;
  if (x.t === "null" || y.t === "null") {
    if (ordered) d.error("not-comparable", at, "null has no order");
    return;
  }
  if (x.t !== y.t) {
    d.error("not-comparable", at, `${describe(x)} cannot be compared with ${describe(y)}`, "nothing is converted: compare values of one type");
    return;
  }
  if (ordered) {
    const dated = (t: Ty) => t.t === "string" && (t.format === "date-time" || t.format === "date");
    if (x.t === "string" && !(dated(x) || dated(y))) d.error("not-comparable", at, "only numbers and date-time strings have an order", "compare with eq or ne, or order a number");
    else if (x.t !== "number" && x.t !== "string") d.error("not-comparable", at, `${describe(x)} has no order`);
  }
  // A literal compared with a field of fixed values must be one of them.
  if (x.t === "string" && y.t === "string" && x.enum && y.enum) {
    const [field, lit] = x.enum.length >= y.enum.length ? [x.enum, y.enum] : [y.enum, x.enum];
    const outside = lit.filter((v) => !field.includes(v));
    if (outside.length === lit.length && field.length > 1) d.error("not-in-enum", at, `${outside.map((v) => JSON.stringify(v)).join(", ")} is never ${describe({ t: "string", enum: field })}`, "the condition can never be true");
  }
}

/** Whether a condition is a literal false (a step that never runs). */
export const alwaysFalse = (e: Expr | undefined): boolean => e === false;

/** Every `$head` an expression refers to, without checking it. */
export function refsOf(e: unknown): string[] {
  const out: string[] = [];
  const visit = (x: unknown) => {
    if (typeof x === "string") {
      const r = isRef(x) ? parseRef(x) : undefined;
      if (r) out.push(r.head);
    } else if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === "object" && !isLiteral(x)) Object.values(x as Record<string, unknown>).forEach(visit);
  };
  visit(e);
  return out;
}

/** The schema a typed value would be, for a compute step's output and a generated contract. */
export function tyToSchema(ty: Ty): JsonSchema2020 {
  switch (ty.t) {
    case "string":
      return { type: "string", ...(ty.enum ? { enum: [...ty.enum] } : {}), ...(ty.format ? { format: ty.format } : {}) };
    case "number":
      return { type: ty.integer ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "list":
      return { type: "array", items: tyToSchema(ty.of) };
    case "object":
      return { type: "object", properties: Object.fromEntries(Object.entries(ty.fields).map(([k, f]) => [k, tyToSchema(f.ty)])) };
    case "unknown":
      return {};
  }
}

export { mayBeUnknown, pointer };
