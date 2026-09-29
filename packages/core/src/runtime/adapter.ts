import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { QueryFilter, SortKey } from "../model/query.js";
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
 * Per-call options the runtime threads into every adapter call (see
 * ADR-0026). Optional throughout: an adapter that omits the parameter still
 * satisfies the interface and still works — it just forgoes cooperative
 * cancellation.
 */
export interface AdapterCallOptions {
  /**
   * Aborts when the runtime's per-call deadline fires. A cooperative adapter
   * should stop in-flight work and reject; an adapter that ignores it still
   * gets request-level liveness from the runtime's timeout race, but its
   * abandoned work runs to completion — so honor it where the backend allows.
   */
  signal?: AbortSignal;
}

/**
 * The seam that separates "what something IS" from "where its data comes
 * from" (see ADR-0006). The runtime never branches on which adapter it is
 * talking to — every adapter style implements this same interface.
 */
export interface Adapter {
  readonly dataSourceId: string;
  resolveProperties(typeName: string, objectId: string, propertyNames: string[], opts?: AdapterCallOptions): Promise<ResolvedProperties>;
  queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[], opts?: AdapterCallOptions): Promise<AdapterQueryResult>;
  resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string, opts?: AdapterCallOptions): Promise<RelatedRef[]>;
  executeAction(action: ActionDefinition, input: unknown, ctx: ActionContext, opts?: AdapterCallOptions): Promise<unknown>;
}
