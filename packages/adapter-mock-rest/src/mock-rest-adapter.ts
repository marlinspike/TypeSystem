import {
  matchesFilter,
  applySort,
  parseResolution,
  UnsupportedResolutionError,
  type Adapter,
  type AdapterCallOptions,
  type AdapterQueryResult,
  type RelatedRef,
  type ResolvedProperties,
  type ActionContext,
  type ActionDefinition,
  type ProvenanceRef,
  type QueryFilter,
  type RelationshipDefinition,
  type SortKey
} from "@typesys/core";
import type { MockRestClient} from "./mock-rest-client.js";
import { type ExternalMaintenanceRecord, type ExternalWorkOrderRecord } from "./mock-rest-client.js";

export interface MockRestAdapterTypeMapping {
  maintenanceEventType: string;
  workOrderType: string;
}

function paginate<T>(items: T[], limit?: number, cursor?: string): { page: T[]; nextCursor?: string } {
  const startIndex = cursor ? Number(cursor) : 0;
  const pageSize = limit ?? items.length;
  const page = items.slice(startIndex, startIndex + pageSize);
  const nextCursor = startIndex + pageSize < items.length ? String(startIndex + pageSize) : undefined;
  return { page, nextCursor };
}

/**
 * The vertical slice's second adapter style (see ADR-0006): translates a
 * mocked external REST-shaped system (snake_case fields, its own record
 * identifiers) into the canonical semantic model, simulating the shape of
 * a real system like REMIS without requiring one to be running.
 *
 * It forwards the runtime's per-call `AbortSignal` (ADR-0026) to its client's
 * simulated network calls, so a call the runtime deadline abandons stops
 * promptly rather than running to completion — what a real REST client would
 * do with an aborted `fetch`.
 */
export class MockRestAdapter implements Adapter {
  readonly dataSourceId: string;
  private readonly systemName: string;

  constructor(
    dataSourceId: string,
    private readonly client: MockRestClient,
    private readonly typeMapping: MockRestAdapterTypeMapping,
    systemName = "REMIS (mock)"
  ) {
    this.dataSourceId = dataSourceId;
    this.systemName = systemName;
  }

  private toCanonicalMaintenanceEvent(r: ExternalMaintenanceRecord): Record<string, unknown> {
    return {
      id: r.event_id,
      aircraftId: r.aircraft_tail,
      eventType: r.event_type,
      occurredAt: r.event_date,
      description: r.notes
    };
  }

  private toCanonicalWorkOrder(r: ExternalWorkOrderRecord): Record<string, unknown> {
    return {
      id: r.wo_id,
      maintenanceEventId: r.event_id,
      status: r.status,
      assignedTo: r.assigned_to,
      createdAt: r.created_at
    };
  }

  private buildProvenance(objectId: string, values: Record<string, unknown>): ProvenanceRef[] {
    const retrievedAt = new Date().toISOString();
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: this.systemName, recordId: objectId, field },
      retrievedAt,
      confidence: 0.9
    }));
  }

  private async listCanonical(typeName: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (typeName === this.typeMapping.maintenanceEventType) {
      return (await this.client.listAllMaintenanceEvents(signal)).map((r) => this.toCanonicalMaintenanceEvent(r));
    }
    if (typeName === this.typeMapping.workOrderType) {
      return (await this.client.listAllWorkOrders(signal)).map((r) => this.toCanonicalWorkOrder(r));
    }
    throw new Error(`MockRestAdapter has no mapping for type "${typeName}"`);
  }

  async resolveProperties(
    typeName: string,
    objectId: string,
    _propertyNames: string[],
    opts?: AdapterCallOptions
  ): Promise<ResolvedProperties> {
    if (typeName === this.typeMapping.maintenanceEventType) {
      const record = await this.client.getMaintenanceEvent(objectId, opts?.signal);
      if (!record) return { values: {}, provenance: [] };
      const values = this.toCanonicalMaintenanceEvent(record);
      return { values, provenance: this.buildProvenance(objectId, values) };
    }
    if (typeName === this.typeMapping.workOrderType) {
      const record = await this.client.getWorkOrder(objectId, opts?.signal);
      if (!record) return { values: {}, provenance: [] };
      const values = this.toCanonicalWorkOrder(record);
      return { values, provenance: this.buildProvenance(objectId, values) };
    }
    throw new Error(`MockRestAdapter has no mapping for type "${typeName}"`);
  }

  async queryByType(
    typeName: string,
    filter?: QueryFilter,
    limit?: number,
    cursor?: string,
    sort?: SortKey[],
    opts?: AdapterCallOptions
  ): Promise<AdapterQueryResult> {
    const all = await this.listCanonical(typeName, opts?.signal);
    const filtered = filter ? all.filter((v) => matchesFilter(v, filter)) : all;
    const sorted = applySort(filtered, sort, (v) => v);
    const { page, nextCursor } = paginate(sorted, limit, cursor);
    return {
      items: page.map((v) => ({
        objectId: v.id as string,
        values: v,
        provenance: this.buildProvenance(v.id as string, v)
      })),
      nextCursor
    };
  }

  async resolveRelationship(
    relationship: RelationshipDefinition,
    sourceObjectId: string,
    opts?: AdapterCallOptions
  ): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind !== "byForeignKey") {
      throw new UnsupportedResolutionError(`MockRestAdapter only supports byForeignKey relationships, not "${strategy.kind}"`);
    }
    const targets = await this.listCanonical(relationship.targetType, opts?.signal);
    return targets.filter((v) => v[strategy.field] === sourceObjectId).map((v) => ({ objectId: v.id as string }));
  }

  async executeAction(
    action: ActionDefinition,
    input: unknown,
    _ctx: ActionContext,
    opts?: AdapterCallOptions
  ): Promise<unknown> {
    if (action.implementation.operation === "createWorkOrder") {
      const typedInput = input as { maintenanceEventId: string; assignedTo: string };
      const record = await this.client.createWorkOrder(
        {
          event_id: typedInput.maintenanceEventId,
          assigned_to: typedInput.assignedTo
        },
        opts?.signal
      );
      return this.toCanonicalWorkOrder(record);
    }
    throw new Error(`MockRestAdapter has no implementation for action "${action.name}" (operation "${action.implementation.operation}")`);
  }
}
