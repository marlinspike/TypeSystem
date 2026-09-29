import type { Pool } from "pg";
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

/**
 * The real-backend counterpart to `@typesys/adapter-in-memory` — same
 * `Adapter` contract, same generic "one row per object" shape, but every
 * read and write is a genuine round trip to PostgreSQL. Proves the
 * architecture against real infrastructure, not just fakes (see
 * `docs/completeness.md`).
 *
 * The `objects` table is intentionally generic (`type_name`, `object_id`,
 * `values jsonb`) rather than one hand-designed table per Type — this
 * keeps the adapter usable for any Type without a bespoke migration per
 * domain. A real production deployment for one specific, high-volume Type
 * would typically graduate to its own dedicated table/columns and its own
 * `Adapter` implementation instead — see the package README.
 */
export class PostgresRepositoryAdapter implements Adapter {
  constructor(
    private readonly pool: Pool,
    public readonly dataSourceId: string,
    private readonly systemName: string = dataSourceId
  ) {}

  /** Write path — seed data for a demo/test, or use directly from application code that owns writes outside of an Action. */
  async put(typeName: string, objectId: string, values: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO objects (type_name, object_id, values)
       VALUES ($1, $2, $3)
       ON CONFLICT (type_name, object_id) DO UPDATE SET values = EXCLUDED.values, updated_at = now()`,
      [typeName, objectId, JSON.stringify(values)]
    );
  }

  async delete(typeName: string, objectId: string): Promise<void> {
    await this.pool.query(`DELETE FROM objects WHERE type_name = $1 AND object_id = $2`, [typeName, objectId]);
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
    const { rows } = await this.pool.query<{ values: Record<string, unknown> }>(
      `SELECT values FROM objects WHERE type_name = $1 AND object_id = $2`,
      [typeName, objectId]
    );
    if (rows.length === 0) return { values: {}, provenance: [] };
    return { values: rows[0]!.values, provenance: this.buildProvenance(objectId, rows[0]!.values) };
  }

  async queryByType(
    typeName: string,
    filter?: QueryFilter,
    limit?: number,
    cursor?: string,
    sort?: SortKey[],
    _opts?: AdapterCallOptions
  ): Promise<AdapterQueryResult> {
    // Default order is object_id (stable paging); an explicit `sort` (ADR-0027) overrides it, applied
    // in JS over the fetched-and-filtered set — consistent with this adapter's fetch-then-page shape.
    const { rows } = await this.pool.query<{ object_id: string; values: Record<string, unknown> }>(
      `SELECT object_id, values FROM objects WHERE type_name = $1 ORDER BY object_id`,
      [typeName]
    );
    const filtered = filter ? rows.filter((r) => matchesFilter(r.values, filter)) : rows;
    const sorted = applySort(filtered, sort, (r) => r.values);

    const startIndex = cursor ? Number(cursor) : 0;
    const pageSize = limit ?? sorted.length;
    const page = sorted.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < sorted.length ? String(startIndex + pageSize) : undefined;

    return {
      items: page.map((r) => ({
        objectId: r.object_id,
        values: r.values,
        provenance: this.buildProvenance(r.object_id, r.values)
      })),
      nextCursor
    };
  }

  async aggregate(query: SemanticAggregateQuery, _opts?: AdapterCallOptions): Promise<AggregateResult> {
    // Generic table (see class doc): fetch this type's rows and aggregate in JS via the shared
    // interpreter — consistent with this adapter's fetch-then-process shape. A high-volume Type
    // would graduate to a bespoke adapter pushing GROUP BY into SQL.
    const { rows } = await this.pool.query<{ values: Record<string, unknown> }>(
      `SELECT values FROM objects WHERE type_name = $1`,
      [query.type]
    );
    const all = rows.map((r) => r.values);
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
        // Pushed down as a real JSONB query (indexed by the GIN index in the migration),
        // not a fetch-everything-then-filter-in-JS pass like the in-memory adapter can afford —
        // being backed by a real database changes how resolution is implemented, not just where
        // the bytes live.
        const { rows } = await this.pool.query<{ object_id: string }>(
          `SELECT object_id FROM objects WHERE type_name = $1 AND values ->> $2 = $3`,
          [relationship.targetType, strategy.field, sourceObjectId]
        );
        return rows.map((r) => ({ objectId: r.object_id }));
      }
      case "byOwnField": {
        // The source record's own field value IS the target's object id.
        const { rows } = await this.pool.query<{ values: Record<string, unknown> }>(
          `SELECT values FROM objects WHERE type_name = $1 AND object_id = $2`,
          [relationship.sourceType, sourceObjectId]
        );
        const targetId = rows[0]?.values[strategy.field];
        return typeof targetId === "string" ? [{ objectId: targetId }] : [];
      }
      case "byJoinTable": {
        if (strategy.dataSourceId && strategy.dataSourceId !== this.dataSourceId) {
          throw new UnsupportedResolutionError(
            `PostgresRepositoryAdapter cannot resolve a byJoinTable whose join collection lives in another data source ("${strategy.dataSourceId}")`
          );
        }
        // Association rows are ordinary objects of the join type; read the target key off each
        // row whose source key matches this source object.
        const { rows } = await this.pool.query<{ target: string | null }>(
          `SELECT values ->> $2 AS target FROM objects WHERE type_name = $1 AND values ->> $3 = $4`,
          [strategy.joinType, strategy.targetKey, strategy.sourceKey, sourceObjectId]
        );
        return rows
          .map((r) => r.target)
          .filter((t): t is string => typeof t === "string")
          .map((objectId) => ({ objectId }));
      }
      case "byCompositeKey": {
        const { rows: srcRows } = await this.pool.query<{ values: Record<string, unknown> }>(
          `SELECT values FROM objects WHERE type_name = $1 AND object_id = $2`,
          [relationship.sourceType, sourceObjectId]
        );
        const source = srcRows[0]?.values;
        if (!source) return [];
        const conditions: string[] = [];
        const params: unknown[] = [relationship.targetType];
        for (const k of strategy.keys) {
          const sourceValue = source[k.sourceField];
          // A missing or non-scalar key part matches nothing (composite keys join on scalar fields).
          if (typeof sourceValue !== "string" && typeof sourceValue !== "number" && typeof sourceValue !== "boolean") {
            return [];
          }
          // Compare as text against the JSONB ->> extraction, the same shape byForeignKey uses.
          params.push(k.targetField, String(sourceValue));
          conditions.push(`values ->> $${params.length - 1} = $${params.length}`);
        }
        const { rows } = await this.pool.query<{ object_id: string }>(
          `SELECT object_id FROM objects WHERE type_name = $1 AND ${conditions.join(" AND ")}`,
          params
        );
        return rows.map((r) => ({ objectId: r.object_id }));
      }
    }
  }

  async executeAction(action: ActionDefinition, _input: unknown, _ctx: ActionContext): Promise<unknown> {
    throw new Error(`PostgresRepositoryAdapter has no implementation for action "${action.name}"`);
  }
}
