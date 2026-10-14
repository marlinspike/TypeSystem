import type { ExecutionPlan, ProvenanceRef, QueryFilter, QueryInclude, ResolvedObject, SemanticQuery, SortKey } from "@typesys/core";
import { toFilter, type Where } from "./expr.js";
import type { ModelShape, RelationshipName, RelationshipTarget, Row, StoredKey, TypeName, ValueKey } from "./model.js";
import type { Transport } from "./transport.js";

/** One page of rows and the cursor to the next, exactly as the runtime paginates (ADR-0054). */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor?: string;
}

export type SortDirection = "asc" | "desc";

/** The rows an included relationship adds to its parent: always an array, as the runtime returns it. */
type Included<M extends ModelShape, N extends TypeName<M>, R extends RelationshipName<M, N>, K extends ValueKey<M, RelationshipTarget<M, N, R>>, I> = {
  readonly [P in R]: Row<M, RelationshipTarget<M, N, R>, K, I>[];
};

type IncludeBuild<M extends ModelShape, T extends TypeName<M>, K extends ValueKey<M, T>, I> = (q: IncludeQuery<M, T>) => IncludeQuery<M, T, K, I>;

/** AND-combines a new filter with whatever the builder already holds, flattening so the runtime sees one conjunction (ADR-0054). */
function conjoin(existing: QueryFilter | undefined, next: QueryFilter): QueryFilter {
  if (!existing) return next;
  const parts = (f: QueryFilter) => ("and" in f ? f.and : [f]);
  return { and: [...parts(existing), ...parts(next)] };
}

function addInclude(includes: QueryInclude[] | undefined, relationship: string, build: ((q: IncludeQuery<never, never>) => IncludeQuery<never, never>) | undefined): QueryInclude[] {
  const nested = build ? build(new IncludeQuery({ relationship })).spec : { relationship };
  return [...(includes ?? []).filter((i) => i.relationship !== relationship), nested];
}

/**
 * A relationship to include, shaped like a query of its target (ADR-0028):
 * its own projection, filter, order, limit, and nested includes. Unlike a
 * top-level sort, an include's runs after resolution, so it may order on a
 * computed property.
 */
export class IncludeQuery<M extends ModelShape, N extends TypeName<M>, K extends ValueKey<M, N> = ValueKey<M, N>, I = unknown> {
  /** @internal Built by `include()`; the spec is the wire `QueryInclude`. */
  constructor(readonly spec: QueryInclude) {}

  select<P extends ValueKey<M, N>>(...properties: P[]): IncludeQuery<M, N, P, I> {
    return new IncludeQuery({ ...this.spec, select: properties });
  }

  where(where: Where<M, N>): IncludeQuery<M, N, K, I> {
    return new IncludeQuery({ ...this.spec, filter: conjoin(this.spec.filter, toFilter(where)) });
  }

  orderBy(property: ValueKey<M, N>, direction: SortDirection = "asc"): IncludeQuery<M, N, K, I> {
    return new IncludeQuery({ ...this.spec, sort: [...(this.spec.sort ?? []), { property, direction }] });
  }

  limit(n: number): IncludeQuery<M, N, K, I> {
    return new IncludeQuery({ ...this.spec, limit: n });
  }

  include<R extends RelationshipName<M, N>, K2 extends ValueKey<M, RelationshipTarget<M, N, R>> = ValueKey<M, RelationshipTarget<M, N, R>>, I2 = unknown>(
    relationship: R,
    build?: IncludeBuild<M, RelationshipTarget<M, N, R>, K2, I2>
  ): IncludeQuery<M, N, K, I & Included<M, N, R, K2, I2>> {
    return new IncludeQuery({ ...this.spec, include: addInclude(this.spec.include, relationship, build as never) });
  }
}

/** Wire objects to rows: id and Type beside the values, included relationships converted the same way, recursively. */
export function toRow(object: ResolvedObject, includes: readonly QueryInclude[] | undefined, withProvenance: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = { $id: object.objectId, $type: object.typeName, ...object.values };
  for (const inc of includes ?? []) {
    const related = object.values[inc.relationship];
    row[inc.relationship] = Array.isArray(related) ? related.map((r) => toRow(r as ResolvedObject, inc.include, false)) : [];
  }
  if (withProvenance) row.$provenance = object.provenance ?? [];
  return row;
}

/**
 * An immutable, typed query of one Type (ADR-0055). Each method returns a new
 * query; `toQuery()` is the `SemanticQuery` it stands for, and that query is
 * all a transport ever receives, so the runtime validates, plans, authorizes,
 * and audits it exactly as it would a hand-written one.
 */
export class Query<M extends ModelShape, N extends TypeName<M>, K extends ValueKey<M, N> = ValueKey<M, N>, I = unknown> {
  /** @internal Built by `client.from()`. */
  constructor(
    private readonly transport: Transport,
    private readonly spec: SemanticQuery
  ) {}

  private with(changes: Partial<SemanticQuery>): Query<M, N, K, I> {
    return new Query(this.transport, { ...this.spec, ...changes });
  }

  /** Return only these values on each row; included relationships are returned regardless. */
  select<P extends ValueKey<M, N>>(...properties: P[]): Query<M, N, P, I> {
    return new Query(this.transport, { ...this.spec, select: properties });
  }

  /** Filter, on stored and computed properties alike (ADR-0054). Calling it again AND-combines. */
  where(where: Where<M, N>): Query<M, N, K, I> {
    return this.with({ filter: conjoin(this.spec.filter, toFilter(where)) });
  }

  /** Case-insensitive text search (ADR-0027), over the named stored properties or the Type's readable string ones. */
  search(text: string, properties?: StoredKey<M, N>[]): Query<M, N, K, I> {
    return this.with({ search: properties ? { text, properties } : { text } });
  }

  /** Order by a stored property. The source system sorts, so a computed property cannot be named here; it can in an include. */
  orderBy(property: StoredKey<M, N>, direction: SortDirection = "asc"): Query<M, N, K, I> {
    const key: SortKey = { property, direction };
    return this.with({ sort: [...(this.spec.sort ?? []), key] });
  }

  /** The page size. The runtime defaults and caps it (`QueryLimits`). */
  limit(n: number): Query<M, N, K, I> {
    return this.with({ limit: n });
  }

  include<R extends RelationshipName<M, N>, K2 extends ValueKey<M, RelationshipTarget<M, N, R>> = ValueKey<M, RelationshipTarget<M, N, R>>, I2 = unknown>(
    relationship: R,
    build?: IncludeBuild<M, RelationshipTarget<M, N, R>, K2, I2>
  ): Query<M, N, K, I & Included<M, N, R, K2, I2>> {
    return new Query(this.transport, { ...this.spec, include: addInclude(this.spec.include, relationship, build as never) });
  }

  /** Each row carries `$provenance`: where each of its values came from. */
  withProvenance(): Query<M, N, K, I & { readonly $provenance: readonly ProvenanceRef[] }> {
    return new Query(this.transport, { ...this.spec, includeProvenance: true });
  }

  /** The `SemanticQuery` this builder stands for: plain JSON, for logging, review, or any transport. */
  toQuery(): SemanticQuery {
    return structuredClone(this.spec);
  }

  /** One page. Pass the previous page's `nextCursor` for the next. A page can be short of `limit` and still have a next one (ADR-0054). */
  async page(cursor?: string): Promise<Page<Row<M, N, K, I>>> {
    const q = cursor === undefined ? this.spec : { ...this.spec, cursor };
    const result = await this.transport.query(q);
    const items = result.items.map((o) => toRow(o, this.spec.include, this.spec.includeProvenance === true) as Row<M, N, K, I>);
    return result.nextCursor === undefined ? { items } : { items, nextCursor: result.nextCursor };
  }

  /** Every row, page after page, until the runtime reports no next page. */
  async *all(): AsyncGenerator<Row<M, N, K, I>, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.page(cursor);
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  /** The first row, or `undefined` when no row matches or none is readable. */
  async first(): Promise<Row<M, N, K, I> | undefined> {
    for await (const row of this.limit(1).all()) return row;
    return undefined;
  }

  /** How the runtime would run this query, without running it (ADR-0054). */
  explain(): Promise<ExecutionPlan> {
    return this.transport.explain(this.spec);
  }
}
