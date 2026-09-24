import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { QueryFilter } from "../model/query.js";
import type { ActionContext } from "../model/context.js";

export interface ResolvedProperties {
  values: Record<string, unknown>;
  provenance: ProvenanceRef[];
}

export interface RelatedRef {
  objectId: string;
  edgeMetadata?: Record<string, unknown>;
}

export interface AdapterQueryResult {
  items: { objectId: string; values: Record<string, unknown>; provenance: ProvenanceRef[] }[];
  nextCursor?: string;
}

/**
 * The seam that separates "what something IS" from "where its data comes
 * from" (see ADR-0006). The runtime never branches on which adapter it is
 * talking to — every adapter style implements this same interface.
 */
export interface Adapter {
  readonly dataSourceId: string;
  resolveProperties(typeName: string, objectId: string, propertyNames: string[]): Promise<ResolvedProperties>;
  queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string): Promise<AdapterQueryResult>;
  resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]>;
  executeAction(action: ActionDefinition, input: unknown, ctx: ActionContext): Promise<unknown>;
}
