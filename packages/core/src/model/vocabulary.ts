import type { JsonSchema2020 } from "./json-schema.js";
import type { ResolutionMode } from "./data-source.js";

/**
 * The private JSON Schema vocabulary this project layers on top of 2020-12.
 * JSON Schema alone has no concept of relationships, actions, computed
 * properties, policy, or provenance — these `x-*` keywords are authoring
 * sugar that the Registry parses once at registration time into first-class
 * records (RelationshipDefinition[], etc). Consumers never re-parse these
 * annotations at query time.
 */
export const SEMANTIC_VOCAB_URI = "https://typesys.dev/vocab/semantic/v1" as const;

export type Cardinality = "one-to-one" | "one-to-many" | "many-to-many";

export interface XRelationshipSpec {
  target: string;
  cardinality: Cardinality;
  inverse?: string;
  description?: string;
  edgeSchema?: JsonSchema2020;
  resolution: { dataSourceId: string; operation: string };
  /** Defaults to "live" when omitted (see ADR-0016). */
  resolutionMode?: ResolutionMode;
  cacheTtlMs?: number;
}

export interface XRelationships {
  [relationshipName: string]: XRelationshipSpec;
}

export interface XActions {
  actions: string[];
}

export interface XComputedSpec {
  dependsOn: string[];
  binding: string;
  resolutionMode?: ResolutionMode;
  cacheTtlMs?: number;
}

export interface XComputed {
  [propertyName: string]: XComputedSpec;
}

export interface XPolicy {
  objectPolicy?: string;
  propertyPolicies?: Record<string, string>;
}

export interface XProvenance {
  /** The Type's own classification: the marking of every object of it (ADR-0032). */
  defaultClassification?: string;
  /** Per member (property or relationship). `classification` marks that member, independently of the Type's (ADR-0032). */
  properties?: Record<string, { authoritativeSource?: string; classification?: string }>;
}

export interface XMetadata {
  owner?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface SemanticTypeSchema extends JsonSchema2020 {
  $id: string;
  $schema?: string;
  title: string;
  description?: string;
  "x-relationships"?: XRelationships;
  "x-actions"?: XActions;
  "x-computed"?: XComputed;
  "x-policy"?: XPolicy;
  "x-provenance"?: XProvenance;
  "x-metadata"?: XMetadata;
}

/** The `x-*` keywords Ajv must be told to tolerate under strict mode. */
export const SEMANTIC_X_KEYWORDS = [
  "x-relationships",
  "x-actions",
  "x-computed",
  "x-policy",
  "x-provenance",
  "x-metadata"
] as const;
