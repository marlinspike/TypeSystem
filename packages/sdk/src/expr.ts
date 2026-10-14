import type { QueryCondition, QueryFilter, QueryOperator } from "@typesys/core";
import type { ModelShape, TypeName, ValueKey, Values } from "./model.js";

/**
 * A filter over one Type, built from typed field references (ADR-0055). It is
 * only ever a `QueryFilter`, the structure every transport already accepts
 * (ADR-0011), so a typed filter can do nothing an untyped one cannot. The
 * brand keeps a filter built for one Type off a query of another.
 */
export class Expr<N extends string = string> {
  declare private readonly brand: N;

  constructor(readonly filter: QueryFilter) {}

  and(...others: Expr<N>[]): Expr<N> {
    return and(this, ...others);
  }

  or(...others: Expr<N>[]): Expr<N> {
    return or(this, ...others);
  }
}

export function and<N extends string>(...exprs: Expr<N>[]): Expr<N> {
  return combine("and", exprs);
}

export function or<N extends string>(...exprs: Expr<N>[]): Expr<N> {
  return combine("or", exprs);
}

/** Nested conjunctions flatten, so `a.and(b).and(c)` is one `and` of three, the shape the runtime's filter split reads best (ADR-0054). */
function combine<N extends string>(op: "and" | "or", exprs: Expr<N>[]): Expr<N> {
  if (exprs.length === 0) throw new Error(`${op}() needs at least one expression`);
  if (exprs.length === 1) return exprs[0]!;
  const parts = exprs.flatMap((e) => (op in e.filter ? (e.filter as Record<typeof op, QueryFilter[]>)[op] : [e.filter]));
  return new Expr<N>(op === "and" ? { and: parts } : { or: parts });
}

/**
 * The operators the runtime applies to a value of type `T` (see the shared
 * interpreter, `matchesFilter`): ordering on numbers, substring on strings,
 * membership on arrays. Offering any other would type-check a filter that
 * silently matches nothing.
 */
export type Field<N extends string, T> = {
  eq(value: T): Expr<N>;
  ne(value: T): Expr<N>;
  in(values: readonly T[]): Expr<N>;
} & (NonNullable<T> extends number
  ? { gt(value: number): Expr<N>; gte(value: number): Expr<N>; lt(value: number): Expr<N>; lte(value: number): Expr<N> }
  : unknown) &
  (NonNullable<T> extends string ? { icontains(text: string): Expr<N> } : unknown) &
  (NonNullable<T> extends readonly (infer E)[] ? { contains(element: E): Expr<N> } : unknown);

export type Fields<M extends ModelShape, N extends TypeName<M>> = { readonly [P in ValueKey<M, N>]-?: Field<N, Values<M, N>[P]> };

/** Equality shorthand: `{ status: "open", priority: 1 }` is `status = "open" and priority = 1`. */
export type Match<M extends ModelShape, N extends TypeName<M>> = { readonly [P in ValueKey<M, N>]?: Values<M, N>[P] };

export type Where<M extends ModelShape, N extends TypeName<M>> = Expr<N> | Match<M, N> | ((fields: Fields<M, N>) => Expr<N>);

const OPERATORS: readonly QueryOperator[] = ["eq", "ne", "in", "gt", "gte", "lt", "lte", "icontains", "contains"];

function fieldRef(property: string): Record<QueryOperator, (value: unknown) => Expr> {
  const ref = {} as Record<QueryOperator, (value: unknown) => Expr>;
  for (const operator of OPERATORS) {
    ref[operator] = (value: unknown) => new Expr({ property, operator, value } satisfies QueryCondition);
  }
  return ref;
}

/** Field references for any property name; the static types above decide which names and operators a caller may use. */
const FIELDS: unknown = new Proxy(
  {},
  {
    get: (_target, property) => (typeof property === "string" ? fieldRef(property) : undefined)
  }
);

export function toFilter<M extends ModelShape, N extends TypeName<M>>(where: Where<M, N>): QueryFilter {
  if (where instanceof Expr) return where.filter;
  if (typeof where === "function") return where(FIELDS as Fields<M, N>).filter;
  const conditions: QueryCondition[] = Object.entries(where)
    .filter(([, value]) => value !== undefined)
    .map(([property, value]) => ({ property, operator: "eq", value }));
  if (conditions.length === 0) throw new Error("where({}) names no property");
  return conditions.length === 1 ? conditions[0]! : { and: conditions };
}

/** Typed field references for a Type, for building a reusable `Expr` outside a query: `fields<Model, "airforce.Aircraft">().needsAttention.eq(true)`. */
export function fields<M extends ModelShape, N extends TypeName<M>>(): Fields<M, N> {
  return FIELDS as Fields<M, N>;
}
