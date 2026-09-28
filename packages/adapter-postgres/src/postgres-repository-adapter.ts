import type { Pool } from "pg";
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

function parseOperation(operation: string): { kind: "byForeignKey" | "byOwnField"; field: string } {
  const [kind, field] = operation.split(":");
  if ((kind !== "byForeignKey" && kind !== "byOwnField") || !field) {
    throw new Error(
      `PostgresRepositoryAdapter only supports "byForeignKey:<field>"/"byOwnField:<field>" relationship operations, got "${operation}"`
    );
  }
  return { kind, field };
}

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
    cursor?: string
  ): Promise<AdapterQueryResult> {
    const { rows } = await this.pool.query<{ object_id: string; values: Record<string, unknown> }>(
      `SELECT object_id, values FROM objects WHERE type_name = $1 ORDER BY object_id`,
      [typeName]
    );
    const filtered = filter ? rows.filter((r) => matchesFilter(r.values, filter)) : rows;

    const startIndex = cursor ? Number(cursor) : 0;
    const pageSize = limit ?? filtered.length;
    const page = filtered.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < filtered.length ? String(startIndex + pageSize) : undefined;

    return {
      items: page.map((r) => ({
        objectId: r.object_id,
        values: r.values,
        provenance: this.buildProvenance(r.object_id, r.values)
      })),
      nextCursor
    };
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string): Promise<RelatedRef[]> {
    const { kind, field } = parseOperation(relationship.resolution.operation);

    if (kind === "byForeignKey") {
      // Pushed down as a real JSONB query (indexed by the GIN index in the migration),
      // not a fetch-everything-then-filter-in-JS pass like the in-memory adapter can
      // afford to do — this is the one place being backed by a real database changes
      // how resolution should be implemented, not just where the bytes live.
      const { rows } = await this.pool.query<{ object_id: string }>(
        `SELECT object_id FROM objects WHERE type_name = $1 AND values ->> $2 = $3`,
        [relationship.targetType, field, sourceObjectId]
      );
      return rows.map((r) => ({ objectId: r.object_id }));
    }

    // byOwnField: the source record's own field value IS the target's object id.
    const { rows } = await this.pool.query<{ values: Record<string, unknown> }>(
      `SELECT values FROM objects WHERE type_name = $1 AND object_id = $2`,
      [relationship.sourceType, sourceObjectId]
    );
    const targetId = rows[0]?.values[field];
    return typeof targetId === "string" ? [{ objectId: targetId }] : [];
  }

  async executeAction(action: ActionDefinition, _input: unknown, _ctx: ActionContext): Promise<unknown> {
    throw new Error(`PostgresRepositoryAdapter has no implementation for action "${action.name}"`);
  }
}
