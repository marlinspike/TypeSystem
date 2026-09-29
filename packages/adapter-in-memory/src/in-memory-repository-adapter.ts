import {
  matchesFilter,
  applySort,
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

export interface InMemoryRecord {
  objectId: string;
  values: Record<string, unknown>;
}

function parseOperation(operation: string): { kind: "byForeignKey" | "byOwnField"; field: string } {
  const [kind, field] = operation.split(":");
  if ((kind !== "byForeignKey" && kind !== "byOwnField") || !field) {
    throw new Error(
      `InMemoryRepositoryAdapter only supports "byForeignKey:<field>"/"byOwnField:<field>" relationship operations, got "${operation}"`
    );
  }
  return { kind, field };
}

/**
 * One of the vertical slice's two adapter styles (see ADR-0006): an
 * in-memory repository standing in for a real database-backed store. A
 * Postgres implementation of the same Adapter interface is a documented,
 * optional extension point (packages/registry-store-postgres shows the
 * pattern for the registry; a data-side equivalent would follow the same
 * shape), not required to run tests or the demo.
 */
export class InMemoryRepositoryAdapter implements Adapter {
  readonly dataSourceId: string;
  private readonly systemName: string;
  private readonly recordsByType = new Map<string, Map<string, InMemoryRecord>>();

  constructor(dataSourceId: string, systemName: string = dataSourceId) {
    this.dataSourceId = dataSourceId;
    this.systemName = systemName;
  }

  seed(typeName: string, records: InMemoryRecord[]): void {
    const map = this.recordsByType.get(typeName) ?? new Map<string, InMemoryRecord>();
    for (const record of records) map.set(record.objectId, record);
    this.recordsByType.set(typeName, map);
  }

  private buildProvenance(objectId: string, values: Record<string, unknown>): ProvenanceRef[] {
    const retrievedAt = new Date().toISOString();
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: this.systemName, recordId: objectId, field },
      retrievedAt,
      confidence: 1
    }));
  }

  async resolveProperties(typeName: string, objectId: string, _propertyNames: string[]): Promise<ResolvedProperties> {
    const record = this.recordsByType.get(typeName)?.get(objectId);
    if (!record) return { values: {}, provenance: [] };
    return { values: { ...record.values }, provenance: this.buildProvenance(objectId, record.values) };
  }

  async queryByType(
    typeName: string,
    filter?: QueryFilter,
    limit?: number,
    cursor?: string,
    sort?: SortKey[],
    _opts?: AdapterCallOptions
  ): Promise<AdapterQueryResult> {
    const all = [...(this.recordsByType.get(typeName)?.values() ?? [])];
    const filtered = filter ? all.filter((r) => matchesFilter(r.values, filter)) : all;
    const sorted = applySort(filtered, sort, (r) => r.values);

    const startIndex = cursor ? Number(cursor) : 0;
    const pageSize = limit ?? sorted.length;
    const page = sorted.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < sorted.length ? String(startIndex + pageSize) : undefined;

    return {
      items: page.map((r) => ({
        objectId: r.objectId,
        values: { ...r.values },
        provenance: this.buildProvenance(r.objectId, r.values)
      })),
      nextCursor
    };
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const { kind, field } = parseOperation(relationship.resolution.operation);

    if (kind === "byForeignKey") {
      const targetRecords = [...(this.recordsByType.get(relationship.targetType)?.values() ?? [])];
      const matches = targetRecords.filter((r) => r.values[field] === sourceObjectId);
      return matches.map((r) => ({ objectId: r.objectId }));
    }

    // byOwnField: the source record's own field value IS the target's object id
    // (e.g. Appointment.providerId names which Provider this Appointment is with).
    const sourceRecord = this.recordsByType.get(relationship.sourceType)?.get(sourceObjectId);
    const targetId = sourceRecord?.values[field];
    return typeof targetId === "string" ? [{ objectId: targetId }] : [];
  }

  async executeAction(action: ActionDefinition, _input: unknown, _ctx: ActionContext): Promise<unknown> {
    throw new Error(`InMemoryRepositoryAdapter has no implementation for action "${action.name}"`);
  }
}
