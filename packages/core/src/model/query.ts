/**
 * A small structured JSON query DSL — deliberately not GraphQL or a bespoke
 * query language (see ADR-0011). This shape doubles directly as the MCP
 * `query` tool's inputSchema with zero translation.
 */
export type QueryOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "icontains";

export interface QueryCondition {
  property: string;
  operator: QueryOperator;
  value: unknown;
}

export type QueryFilter =
  | QueryCondition
  | { and: QueryFilter[] }
  | { or: QueryFilter[] };

/** One key of a multi-key sort (see ADR-0027). `direction` defaults to `"asc"`. */
export interface SortKey {
  property: string;
  direction?: "asc" | "desc";
}

export interface QueryInclude {
  relationship: string;
  filter?: QueryFilter;
  /** Projection for this included relationship's objects (ADR-0027): return only these properties (plus nested includes). */
  select?: string[];
  include?: QueryInclude[];
}

/** Case-insensitive substring text search across properties (ADR-0027). Desugars to an `icontains` OR-filter over the resolved, readable, non-computed properties. */
export interface SearchSpec {
  text: string;
  /** Properties to search. Omit to search the type's own readable, non-computed string properties (never a policy-gated one). */
  properties?: string[];
}

export interface SemanticQuery {
  type: string;
  filter?: QueryFilter;
  /** Case-insensitive text search, AND-combined with `filter` (ADR-0027). */
  search?: SearchSpec;
  /** Order the result page by these keys, in priority order (ADR-0027). Runs in the adapter, so it may not name a computed property. */
  sort?: SortKey[];
  /** Return only these properties on each object (ADR-0027). Applied after redaction; requested `include` relationships are returned regardless. */
  select?: string[];
  include?: QueryInclude[];
  includeProvenance?: boolean;
  limit?: number;
  cursor?: string;
}

export interface QueryResult<T = unknown> {
  items: T[];
  nextCursor?: string;
}

/** The aggregation functions the query DSL supports (ADR-0027). `count` may omit `property`; the rest operate on numeric values. */
export type AggregateOp = "count" | "sum" | "avg" | "min" | "max";

export interface Aggregation {
  /** The name this aggregation's value appears under in each group's `values`. */
  name: string;
  op: AggregateOp;
  /** The property to aggregate. Optional only for `count` (which counts rows, or non-null values of the property when given). */
  property?: string;
}

/**
 * A grouped aggregation over a Type (ADR-0027). Deliberately a separate shape
 * from `SemanticQuery`, and resolved by a separate `runtime.aggregate()`,
 * because its result is groups of numbers, not a list of objects.
 */
export interface SemanticAggregateQuery {
  type: string;
  filter?: QueryFilter;
  groupBy?: string[];
  aggregations: Aggregation[];
}

export interface AggregateGroup {
  /** One entry per `groupBy` property (an empty object when not grouping). */
  key: Record<string, unknown>;
  /** Each aggregation's value, keyed by its `name`. */
  values: Record<string, number>;
}

export interface AggregateResult {
  groups: AggregateGroup[];
}
