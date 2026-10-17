/**
 * The operators of an application's expressions (ADR-0079), as the code the
 * compiler generates calls them: `$.and($.gt($.count(lots), 0), …)`.
 *
 * Three-valued (Kleene). `undefined` is *unknown*: a value the runtime
 * withheld from the caller, a step that was skipped, data still loading. An
 * operation on an unknown value is unknown, except where the answer does not
 * depend on it (`and` with a false operand is false, `or` with a true one is
 * true). `null` is a value, not unknown, except that it has no order and no
 * arithmetic. Nothing is coerced: the checker has already refused comparing
 * a string with a number, so these never convert.
 *
 * A condition is acted on only when it is `true`: `when`, `check` and `if`
 * treat unknown as not true. That is the one place unknown is decided, and
 * it is decided the safe way.
 */

/** A value that may be unknown. */
export type Maybe<T> = T | undefined;

const isUnknown = (v: unknown): v is undefined => v === undefined;
const isAbsent = (v: unknown): v is null | undefined => v === undefined || v === null;

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function eq(a: unknown, b: unknown): Maybe<boolean> {
  return isUnknown(a) || isUnknown(b) ? undefined : same(a, b);
}

export function ne(a: unknown, b: unknown): Maybe<boolean> {
  const r = eq(a, b);
  return r === undefined ? undefined : !r;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/** Numbers by value; strings the checker allowed to be ordered are dates, by instant. */
function order(a: unknown, b: unknown): Maybe<number> {
  if (isAbsent(a) || isAbsent(b)) return undefined;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    // Only dates written as dates: Date.parse also accepts "12" or "Bravo 7", which would order by accident.
    if (!ISO_DATE.test(a) || !ISO_DATE.test(b)) return undefined;
    const [x, y] = [Date.parse(a), Date.parse(b)];
    return Number.isNaN(x) || Number.isNaN(y) ? undefined : x - y;
  }
  return undefined;
}

export const lt = (a: unknown, b: unknown): Maybe<boolean> => mapOrder(order(a, b), (d) => d < 0);
export const lte = (a: unknown, b: unknown): Maybe<boolean> => mapOrder(order(a, b), (d) => d <= 0);
export const gt = (a: unknown, b: unknown): Maybe<boolean> => mapOrder(order(a, b), (d) => d > 0);
export const gte = (a: unknown, b: unknown): Maybe<boolean> => mapOrder(order(a, b), (d) => d >= 0);
const mapOrder = (d: Maybe<number>, f: (d: number) => boolean): Maybe<boolean> => (d === undefined ? undefined : f(d));

/** Whether `value` is in `list`: true when found; false only when every element is known and none matches. */
export function inList(value: unknown, list: Maybe<readonly unknown[] | null>): Maybe<boolean> {
  if (isUnknown(value) || isAbsent(list)) return undefined;
  let unknown = false;
  for (const item of list) {
    if (isUnknown(item)) unknown = true;
    else if (same(item, value)) return true;
  }
  return unknown ? undefined : false;
}

export function and(...xs: readonly Maybe<boolean>[]): Maybe<boolean> {
  if (xs.some((x) => x === false)) return false;
  return xs.every((x) => x === true) ? true : undefined;
}

export function or(...xs: readonly Maybe<boolean>[]): Maybe<boolean> {
  if (xs.some((x) => x === true)) return true;
  return xs.every((x) => x === false) ? false : undefined;
}

export function not(x: Maybe<boolean>): Maybe<boolean> {
  return x === undefined ? undefined : !x;
}

/** Known and not null. Always known itself. */
export function exists(v: unknown): boolean {
  return !isAbsent(v);
}

/** Whether a condition holds: only `true` does. What `when`, `check` and `if` decide on. */
export function holds(c: Maybe<boolean>): boolean {
  return c === true;
}

/** `then` when the condition holds, `otherwise` when it does not, unknown included. */
export function cond<T, E>(c: Maybe<boolean>, then: T, otherwise: E): T | E {
  return c === true ? then : otherwise;
}

/** The first value that is known and not null. */
export function coalesce<T>(...xs: readonly T[]): Maybe<NonNullable<T>> {
  for (const x of xs) if (!isAbsent(x)) return x as NonNullable<T>;
  return undefined;
}

type Num = Maybe<number | null>;
const numbers = (xs: readonly Num[]): number[] | undefined => (xs.every((x): x is number => typeof x === "number") ? (xs as number[]) : undefined);

export const add = (...xs: readonly Num[]): Maybe<number> => numbers(xs)?.reduce((a, b) => a + b, 0);
export const mul = (...xs: readonly Num[]): Maybe<number> => numbers(xs)?.reduce((a, b) => a * b, 1);
export function sub(a: Num, b: Num): Maybe<number> {
  return typeof a === "number" && typeof b === "number" ? a - b : undefined;
}
/** A division by zero is unknown, not infinity. */
export function div(a: Num, b: Num): Maybe<number> {
  return typeof a === "number" && typeof b === "number" && b !== 0 ? a / b : undefined;
}

export function round(n: Num, digits = 0): Maybe<number> {
  if (typeof n !== "number") return undefined;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Strings and numbers joined; unknown when any part is. */
export function concat(...xs: readonly unknown[]): Maybe<string> {
  if (xs.some(isAbsent)) return undefined;
  return xs.map((x) => (typeof x === "number" ? String(x) : (x as string))).join("");
}

export function count(list: Maybe<readonly unknown[] | null>): Maybe<number> {
  return isAbsent(list) ? undefined : list.length;
}

/** The numbers of a list, or of one field of each element; unknown when the list or any one of them is. */
function valuesOf(list: Maybe<readonly unknown[] | null>, field: string | undefined): number[] | undefined {
  if (isAbsent(list)) return undefined;
  const out: number[] = [];
  for (const item of list) {
    const v = field === undefined ? item : isAbsent(item) ? undefined : (item as Record<string, unknown>)[field];
    if (typeof v !== "number") return undefined;
    out.push(v);
  }
  return out;
}

/**
 * The total; an empty list's is 0. A withheld value makes it unknown rather
 * than leaving it out: a total of what the caller may see would be shown as
 * the total.
 */
export const sum = (list: Maybe<readonly unknown[] | null>, field?: string): Maybe<number> => valuesOf(list, field)?.reduce((a, b) => a + b, 0);
export function avg(list: Maybe<readonly unknown[] | null>, field?: string): Maybe<number> {
  const v = valuesOf(list, field);
  return v && v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
}
export function min(list: Maybe<readonly unknown[] | null>, field?: string): Maybe<number> {
  const v = valuesOf(list, field);
  return v && v.length ? Math.min(...v) : undefined;
}
export function max(list: Maybe<readonly unknown[] | null>, field?: string): Maybe<number> {
  const v = valuesOf(list, field);
  return v && v.length ? Math.max(...v) : undefined;
}

/** The elements the predicate holds for. An element it is unknown for is left out, as a condition that does not hold. */
export function where<T>(list: Maybe<readonly T[] | null>, predicate: (item: T) => Maybe<boolean>): Maybe<T[]> {
  if (isAbsent(list)) return undefined;
  const kept: T[] = [];
  for (const item of list) {
    const holds = predicate(item);
    // Unknown for one element is unknown for the selection: a count or sum over what is left would be a confident understatement.
    if (holds === undefined) return undefined;
    if (holds) kept.push(item);
  }
  return kept;
}

/** One field of each element, unknown where an element lacks it. */
export function pluck<T, K extends keyof T>(list: Maybe<readonly T[] | null>, field: K): Maybe<T[K][]> {
  return isAbsent(list) ? undefined : list.map((item) => (isAbsent(item) ? undefined : item[field]) as T[K]);
}

/** Hours from a date-time to now. Interface only: a flow is replayed, and the clock is not. */
export function hoursSince(when: Maybe<string | null>, now: () => number = Date.now): Maybe<number> {
  if (typeof when !== "string") return undefined;
  const t = Date.parse(when);
  return Number.isNaN(t) ? undefined : (now() - t) / 3_600_000;
}
