/**
 * A small structured JSON query DSL — deliberately not GraphQL or a bespoke
 * query language (see ADR-0011). This shape doubles directly as the MCP
 * `query` tool's inputSchema with zero translation.
 */
export type QueryOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

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

export interface SemanticQuery {
  type: string;
  filter?: QueryFilter;
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
