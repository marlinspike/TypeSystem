import {
  matchesFilter,
  type Adapter,
  type AdapterQueryResult,
  type RelatedRef,
  type ResolvedProperties,
  type ActionContext,
  type ActionDefinition,
  type ProvenanceRef,
  type QueryFilter,
  type RelationshipDefinition
} from "@typesys/core";
import { MockRestClient, type ExternalMaintenanceRecord, type ExternalWorkOrderRecord } from "./mock-rest-client.js";

export interface MockRestAdapterTypeMapping {
  maintenanceEventType: string;
  workOrderType: string;
}

function parseForeignKeyOperation(operation: string): string {
  const [kind, field] = operation.split(":");
  if (kind !== "byForeignKey" || !field) {
    throw new Error(`MockRestAdapter only supports "byForeignKey:<field>" relationship operations, got "${operation}"`);
  }
  return field;
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

  private async listCanonical(typeName: string): Promise<Record<string, unknown>[]> {
    if (typeName === this.typeMapping.maintenanceEventType) {
      return (await this.client.listAllMaintenanceEvents()).map((r) => this.toCanonicalMaintenanceEvent(r));
    }
    if (typeName === this.typeMapping.workOrderType) {
      return (await this.client.listAllWorkOrders()).map((r) => this.toCanonicalWorkOrder(r));
    }
    throw new Error(`MockRestAdapter has no mapping for type "${typeName}"`);
  }

  async resolveProperties(typeName: string, objectId: string, _propertyNames: string[]): Promise<ResolvedProperties> {
    if (typeName === this.typeMapping.maintenanceEventType) {
      const record = await this.client.getMaintenanceEvent(objectId);
      if (!record) return { values: {}, provenance: [] };
      const values = this.toCanonicalMaintenanceEvent(record);
      return { values, provenance: this.buildProvenance(objectId, values) };
    }
    if (typeName === this.typeMapping.workOrderType) {
      const record = await this.client.getWorkOrder(objectId);
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
    cursor?: string
  ): Promise<AdapterQueryResult> {
    const all = await this.listCanonical(typeName);
    const filtered = filter ? all.filter((v) => matchesFilter(v, filter)) : all;
    const { page, nextCursor } = paginate(filtered, limit, cursor);
    return {
      items: page.map((v) => ({
        objectId: v.id as string,
        values: v,
        provenance: this.buildProvenance(v.id as string, v)
      })),
      nextCursor
    };
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const field = parseForeignKeyOperation(relationship.resolution.operation);
    const targets = await this.listCanonical(relationship.targetType);
    return targets.filter((v) => v[field] === sourceObjectId).map((v) => ({ objectId: v.id as string }));
  }

  async executeAction(action: ActionDefinition, input: unknown, _ctx: ActionContext): Promise<unknown> {
    if (action.implementation.operation === "createWorkOrder") {
      const typedInput = input as { maintenanceEventId: string; assignedTo: string };
      const record = await this.client.createWorkOrder({
        event_id: typedInput.maintenanceEventId,
        assigned_to: typedInput.assignedTo
      });
      return this.toCanonicalWorkOrder(record);
    }
    throw new Error(`MockRestAdapter has no implementation for action "${action.name}" (operation "${action.implementation.operation}")`);
  }
}
