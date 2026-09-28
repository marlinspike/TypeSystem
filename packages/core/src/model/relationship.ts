import type { Cardinality } from "./vocabulary.js";
import type { JsonSchema2020 } from "./json-schema.js";
import type { ResolutionMode } from "./data-source.js";

/**
 * Relationships are first-class registry records, not nested JSON (see
 * ADR-0003). Property-graph-flavored on purpose — deliberately not a full
 * graph database.
 */
export interface RelationshipDefinition {
  id: string;
  name: string;
  sourceType: string;
  targetType: string;
  cardinality: Cardinality;
  inverseName?: string;
  edgeSchema?: JsonSchema2020;
  resolution: { dataSourceId: string; operation: string };
  version: string;
  deprecated?: { since: string; supersededBy?: string };
  /** Defaults to "live" when omitted. Only "cached" is meaningfully different (see ADR-0016). */
  resolutionMode?: ResolutionMode;
  /** Only meaningful when `resolutionMode === "cached"`; falls back to the runtime's `defaultCacheTtlMs`. */
  cacheTtlMs?: number;
}
