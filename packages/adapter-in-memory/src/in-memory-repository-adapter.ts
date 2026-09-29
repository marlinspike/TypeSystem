import {
  matchesFilter,
  applySort,
  computeAggregations,
  parseResolution,
  UnsupportedResolutionError,
  type Adapter,
  type AdapterCallOptions,
  type AdapterQueryResult,
  type AggregateResult,
  type RelatedRef,
  type ResolvedProperties,
  type ActionContext,
  type ActionDefinition,
  type ProvenanceRef,
  type QueryFilter,
  type RelationshipDefinition,
  type SemanticAggregateQuery,
  type SortKey
} from "@typesys/core";

export interface InMemoryRecord {
  objectId: string;
  values: Record<string, unknown>;
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

  async aggregate(query: SemanticAggregateQuery, _opts?: AdapterCallOptions): Promise<AggregateResult> {
    const all = [...(this.recordsByType.get(query.type)?.values() ?? [])].map((r) => r.values);
    const filtered = query.filter ? all.filter((v) => matchesFilter(v, query.filter)) : all;
    return computeAggregations(filtered, query);
  }

  async resolveRelationship(
    relationship: RelationshipDefinition,
    sourceObjectId: string,
    _opts?: AdapterCallOptions
  ): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    switch (strategy.kind) {
      case "byForeignKey": {
        const targets = [...(this.recordsByType.get(relationship.targetType)?.values() ?? [])];
        return targets.filter((r) => r.values[strategy.field] === sourceObjectId).map((r) => ({ objectId: r.objectId }));
      }
      case "byOwnField": {
        // The source record's own field value IS the target's object id
        // (e.g. Appointment.providerId names which Provider this Appointment is with).
        const source = this.recordsByType.get(relationship.sourceType)?.get(sourceObjectId);
        const targetId = source?.values[strategy.field];
        return typeof targetId === "string" ? [{ objectId: targetId }] : [];
      }
      case "byJoinTable": {
        if (strategy.dataSourceId && strategy.dataSourceId !== this.dataSourceId) {
          throw new UnsupportedResolutionError(
            `InMemoryRepositoryAdapter cannot resolve a byJoinTable whose join collection lives in another data source ("${strategy.dataSourceId}")`
          );
        }
        const joins = [...(this.recordsByType.get(strategy.joinType)?.values() ?? [])];
        return joins
          .filter((r) => r.values[strategy.sourceKey] === sourceObjectId)
          .map((r) => r.values[strategy.targetKey])
          .filter((id): id is string => typeof id === "string")
          .map((objectId) => ({ objectId }));
      }
      case "byCompositeKey": {
        const source = this.recordsByType.get(relationship.sourceType)?.get(sourceObjectId);
        if (!source) return [];
        const targets = [...(this.recordsByType.get(relationship.targetType)?.values() ?? [])];
        return targets
          .filter((r) => strategy.keys.every((k) => r.values[k.targetField] === source.values[k.sourceField]))
          .map((r) => ({ objectId: r.objectId }));
      }
    }
  }

  async executeAction(action: ActionDefinition, _input: unknown, _ctx: ActionContext): Promise<unknown> {
    throw new Error(`InMemoryRepositoryAdapter has no implementation for action "${action.name}"`);
  }
}
