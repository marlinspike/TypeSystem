import { isFnCall, isLiteral, isRef, operatorOf, parseRef } from "../expr.js";

/**
 * Expressions as TypeScript (ADR-0082): each operator becomes a call of the
 * same name in `@typesys/app`'s `$` (`{ "gt": [a, b] }` is `$.gt(a, b)`), a
 * reference becomes a property path with optional chaining, and a function
 * call becomes a call of the handwritten export. The output reads like the
 * expression, so a person reviewing generated code reviews the meaning.
 */

/** A string literal in TypeScript. */
export const q = (s: string): string => JSON.stringify(s);

/** A property name: bare when it can be, quoted when not. */
export const ident = (s: string): string => (/^[A-Za-z_$][\w$]*$/.test(s) ? s : q(s));

/** `a.b` → `?.b`; `a["x-y"]` → `?.["x-y"]`. */
export const access = (seg: string): string => (/^[A-Za-z_$][\w$]*$/.test(seg) ? `?.${seg}` : `?.[${q(seg)}]`);

/** `cold-chain` → `ColdChain`; `dispositionLot` → `DispositionLot`. */
export const pascal = (s: string): string =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** `cold-chain` → `coldChain`. */
export const camel = (s: string): string => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** Text inside a block comment, which must not end it. */
export const comment = (s: string): string => s.replaceAll("*/", "*\\/");

/** The local name a handwritten module is imported as: `risk` for `risk`, `x_lab_stability` for `lab/stability`. */
export const moduleAlias = (module: string): string => (/^[a-z][a-z0-9]*$/.test(module) ? module : `x_${module.replace(/[^A-Za-z0-9]+/g, "_")}`);

/** How references and functions are written where an expression is emitted. */
export interface ExprTarget {
  /** The TypeScript for `$head` (its root value); undefined when nothing here names it, which the checker has already reported. */
  ref(head: string): string;
}

const SAME_NAME = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "and", "or", "not", "exists", "coalesce", "add", "sub", "mul", "div", "round", "concat", "count", "sum", "avg", "min", "max", "pluck", "hoursSince"]);

/** One expression as TypeScript, for a checked application: anything the checker refused is not expected here. */
export function exprTs(e: unknown, target: ExprTarget): string {
  if (e === null) return "null";
  if (typeof e === "number" || typeof e === "boolean") return String(e);
  if (typeof e === "string") {
    if (!isRef(e)) return q(e);
    const ref = parseRef(e);
    if (!ref) throw new TypeError(`"${e}" is not a reference`);
    return target.ref(ref.head) + ref.path.map(access).join("");
  }
  if (Array.isArray(e)) return `[${e.map((x) => exprTs(x, target)).join(", ")}]`;
  if (typeof e !== "object") throw new TypeError("not an expression");
  if (isLiteral(e)) return JSON.stringify(e.literal);
  if (isFnCall(e)) {
    const [module, name] = e.fn.split("#") as [string, string];
    const args = Object.entries(e.args).map(([k, v]) => `${ident(k)}: ${exprTs(v, target)}`);
    return `${moduleAlias(module)}.${name}({ ${args.join(", ")} })`;
  }
  const found = operatorOf(e);
  if (!found.op) throw new TypeError(found.why);
  const op = found.op;
  const raw = (e as Record<string, unknown>)[op];
  if (op === "not" || op === "exists" || op === "count" || op === "hoursSince") return `$.${op}(${exprTs(raw, target)})`;
  const args = raw as unknown[];
  const each = () => args.map((a) => exprTs(a, target));
  switch (op) {
    case "in":
      return `$.inList(${each().join(", ")})`;
    case "if":
      return `$.cond(${each().join(", ")})`;
    case "where": {
      const list = exprTs(args[0], target);
      const pred = exprTs(args[1], { ref: (h) => (h === "item" ? "item" : target.ref(h)) });
      return `$.where(${list}, (item) => ${pred})`;
    }
    case "pluck":
    case "sum":
    case "avg":
    case "min":
    case "max":
      // A second operand is a field name, written as a plain string.
      return args.length === 2 ? `$.${op}(${exprTs(args[0], target)}, ${q(args[1] as string)})` : `$.${op}(${exprTs(args[0], target)})`;
    default:
      if (!SAME_NAME.has(op)) throw new TypeError(`no TypeScript for operator ${op}`);
      return `$.${op}(${each().join(", ")})`;
  }
}

/** Every handwritten module an expression calls. */
export function fnModules(e: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(e)) e.forEach((x) => fnModules(x, into));
  else if (isFnCall(e)) {
    into.add(e.fn.split("#")[0]!);
    Object.values(e.args).forEach((x) => fnModules(x, into));
  } else if (e && typeof e === "object" && !isLiteral(e)) Object.values(e as Record<string, unknown>).forEach((x) => fnModules(x, into));
  return into;
}
