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

export interface QueryInclude {
  relationship: string;
  filter?: QueryFilter;
  include?: QueryInclude[];
}

export interface SemanticQuery {
  type: string;
  filter?: QueryFilter;
  include?: QueryInclude[];
  includeProvenance?: boolean;
  limit?: number;
  cursor?: string;
}

export interface QueryResult<T = unknown> {
  items: T[];
  nextCursor?: string;
}
