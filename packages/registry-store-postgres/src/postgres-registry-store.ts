import type { Pool } from "pg";
import {
  emptyBindingRegistry,
  latestFirst,
  resolveVersion,
  type ActionDefinition,
  type AuditEvent,
  type BindingRegistry,
  type DataSource,
  type Mapping,
  type QueryResult,
  type RegistryStore,
  type RelationshipDefinition,
  type TypeDefinition
} from "@typesys/core";
import {
  actionRowToDefinition,
  auditEventRowToEvent,
  computedPropertiesToPersisted,
  dataSourceRowToDefinition,
  mappingRowToDefinition,
  preconditionsToPersisted,
  relationshipRowToDefinition,
  toJsonParam,
  typeRowToDefinition,
  type ActionRow,
  type AuditEventRow,
  type DataSourceRow,
  type MappingRow,
  type RelationshipRow,
  type TypeRow
} from "./serialization.js";

/**
 * Production PostgreSQL-backed `RegistryStore` (see ADR-0015). Owns no
 * schema lifecycle of its own — run `npm run migrate` in this package (or
 * call `runMigrations` from `./migrate.js` directly) before constructing
 * one against an empty database.
 *
 * `bindings` supplies the live `compute`/`check` implementations for any
 * `ComputedPropertyDefinition`/`PreconditionSpec` this store might read
 * back — required by whichever process reads them, not just the one that
 * wrote them. See ADR-0015 for why the database can never hold these
 * itself.
 */
export class PostgresRegistryStore implements RegistryStore {
  constructor(
    private readonly pool: Pool,
    private readonly bindings: BindingRegistry = emptyBindingRegistry()
  ) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ------------------------------------------------------------------ types

  async putType(def: TypeDefinition): Promise<void> {
    const computedProperties = computedPropertiesToPersisted(def.computedProperties);
    await this.pool.query(
      `INSERT INTO types (id, name, version, extends, traits, description, schema, action_names, computed_properties, deprecated, aliases, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (name, version) DO UPDATE SET
         id = EXCLUDED.id,
         extends = EXCLUDED.extends,
         traits = EXCLUDED.traits,
         description = EXCLUDED.description,
         schema = EXCLUDED.schema,
         action_names = EXCLUDED.action_names,
         computed_properties = EXCLUDED.computed_properties,
         deprecated = EXCLUDED.deprecated,
         aliases = EXCLUDED.aliases,
         updated_at = now()`,
      [
        def.id,
        def.name,
        def.version,
        def.extends ?? null,
        toJsonParam(def.traits ?? []),
        def.description ?? null,
        toJsonParam(def.schema),
        toJsonParam(def.actionNames),
        toJsonParam(computedProperties),
        toJsonParam(def.deprecated),
        toJsonParam(def.aliases)
      ]
    );
  }

  async getType(name: string, versionRange?: string): Promise<TypeDefinition | undefined> {
    const { rows } = await this.pool.query<TypeRow>(`SELECT * FROM types WHERE name = $1`, [name]);
    const row = resolveVersion(rows, versionRange);
    if (!row) return undefined;
    return typeRowToDefinition(row, await this.fetchRelationships(name), this.bindings);
  }

  async listTypeVersions(name: string): Promise<TypeDefinition[]> {
    const { rows } = await this.pool.query<TypeRow>(`SELECT * FROM types WHERE name = $1`, [name]);
    const relationships = await this.fetchRelationships(name);
    return latestFirst(rows).map((row) => typeRowToDefinition(row, relationships, this.bindings));
  }

  async listTypes(): Promise<TypeDefinition[]> {
    const { rows } = await this.pool.query<TypeRow>(`SELECT * FROM types`);
    const byName = groupBy(rows, (r) => r.name);
    const relationshipsByType = await this.fetchRelationshipsForTypes([...byName.keys()]);
    return [...byName.entries()].map(([name, versions]) =>
      typeRowToDefinition(latestFirst(versions)[0]!, relationshipsByType.get(name) ?? [], this.bindings)
    );
  }

  // ------------------------------------------------------------ relationships

  async putRelationship(def: RelationshipDefinition): Promise<void> {
    await this.pool.query(
      `INSERT INTO relationships (id, name, source_type, target_type, cardinality, inverse_name, edge_schema, resolution, version, deprecated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source_type, name) DO UPDATE SET
         id = EXCLUDED.id,
         target_type = EXCLUDED.target_type,
         cardinality = EXCLUDED.cardinality,
         inverse_name = EXCLUDED.inverse_name,
         edge_schema = EXCLUDED.edge_schema,
         resolution = EXCLUDED.resolution,
         version = EXCLUDED.version,
         deprecated = EXCLUDED.deprecated`,
      [
        def.id,
        def.name,
        def.sourceType,
        def.targetType,
        def.cardinality,
        def.inverseName ?? null,
        toJsonParam(def.edgeSchema),
        toJsonParam(def.resolution),
        def.version,
        toJsonParam(def.deprecated)
      ]
    );
  }

  async listRelationships(sourceType: string): Promise<RelationshipDefinition[]> {
    return this.fetchRelationships(sourceType);
  }

  private async fetchRelationships(sourceType: string): Promise<RelationshipDefinition[]> {
    const { rows } = await this.pool.query<RelationshipRow>(`SELECT * FROM relationships WHERE source_type = $1`, [sourceType]);
    return rows.map(relationshipRowToDefinition);
  }

  private async fetchRelationshipsForTypes(sourceTypes: string[]): Promise<Map<string, RelationshipDefinition[]>> {
    if (sourceTypes.length === 0) return new Map();
    const { rows } = await this.pool.query<RelationshipRow>(`SELECT * FROM relationships WHERE source_type = ANY($1::text[])`, [
      sourceTypes
    ]);
    return groupBy(rows.map(relationshipRowToDefinition), (r) => r.sourceType);
  }

  // ------------------------------------------------------------------ actions

  async putAction(def: ActionDefinition): Promise<void> {
    const preconditions = preconditionsToPersisted(def.preconditions);
    await this.pool.query(
      `INSERT INTO actions (id, name, version, description, applicable_types, input_schema, output_schema,
                             authorization_policy, preconditions, implementation, side_effects, idempotency,
                             audit_required, deprecated, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       ON CONFLICT (name, version) DO UPDATE SET
         id = EXCLUDED.id,
         description = EXCLUDED.description,
         applicable_types = EXCLUDED.applicable_types,
         input_schema = EXCLUDED.input_schema,
         output_schema = EXCLUDED.output_schema,
         authorization_policy = EXCLUDED.authorization_policy,
         preconditions = EXCLUDED.preconditions,
         implementation = EXCLUDED.implementation,
         side_effects = EXCLUDED.side_effects,
         idempotency = EXCLUDED.idempotency,
         audit_required = EXCLUDED.audit_required,
         deprecated = EXCLUDED.deprecated,
         updated_at = now()`,
      [
        def.id,
        def.name,
        def.version,
        def.description,
        toJsonParam(def.applicableTypes),
        toJsonParam(def.inputSchema),
        toJsonParam(def.outputSchema),
        def.authorizationPolicy,
        toJsonParam(preconditions),
        toJsonParam(def.implementation),
        def.sideEffects,
        def.idempotency,
        def.auditRequired,
        toJsonParam(def.deprecated)
      ]
    );
  }

  async getAction(name: string, versionRange?: string): Promise<ActionDefinition | undefined> {
    const { rows } = await this.pool.query<ActionRow>(`SELECT * FROM actions WHERE name = $1`, [name]);
    const row = resolveVersion(rows, versionRange);
    return row ? actionRowToDefinition(row, this.bindings) : undefined;
  }

  async listActions(): Promise<ActionDefinition[]> {
    const { rows } = await this.pool.query<ActionRow>(`SELECT * FROM actions`);
    const byName = groupBy(rows, (r) => r.name);
    return [...byName.values()].map((versions) => actionRowToDefinition(latestFirst(versions)[0]!, this.bindings));
  }

  // -------------------------------------------------------------- data sources

  async putDataSource(ds: DataSource): Promise<void> {
    await this.pool.query(
      `INSERT INTO data_sources (id, name, kind, config)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, config = EXCLUDED.config`,
      [ds.id, ds.name, ds.kind, toJsonParam(ds.config)]
    );
  }

  async getDataSource(id: string): Promise<DataSource | undefined> {
    const { rows } = await this.pool.query<DataSourceRow>(`SELECT * FROM data_sources WHERE id = $1`, [id]);
    return rows[0] ? dataSourceRowToDefinition(rows[0]) : undefined;
  }

  // ------------------------------------------------------------------ mappings

  async putMapping(m: Mapping): Promise<void> {
    await this.pool.query(
      `INSERT INTO mappings (id, type_name, target, target_name, data_source_id, operation, resolution_mode, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         type_name = EXCLUDED.type_name,
         target = EXCLUDED.target,
         target_name = EXCLUDED.target_name,
         data_source_id = EXCLUDED.data_source_id,
         operation = EXCLUDED.operation,
         resolution_mode = EXCLUDED.resolution_mode,
         priority = EXCLUDED.priority`,
      [m.id, m.typeName, m.target, m.targetName, m.dataSourceId, m.operation, m.resolutionMode, m.priority ?? null]
    );
  }

  async listMappings(typeName: string): Promise<Mapping[]> {
    const { rows } = await this.pool.query<MappingRow>(`SELECT * FROM mappings WHERE type_name = $1`, [typeName]);
    return rows.map(mappingRowToDefinition);
  }

  // -------------------------------------------------------------- audit events

  async appendAuditEvent(evt: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, "timestamp", subject_id, action, resource_type_name, resource_object_id,
                                  resource_property_path, decision, reason, outcome, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        evt.id,
        evt.timestamp,
        evt.subjectId,
        evt.action,
        evt.resource.typeName,
        evt.resource.objectId ?? null,
        evt.resource.propertyPath ?? null,
        evt.decision,
        evt.reason ?? null,
        evt.outcome ?? null,
        toJsonParam(evt.details)
      ]
    );
  }

  async listAuditEvents(opts: { limit?: number; before?: string } = {}): Promise<QueryResult<AuditEvent>> {
    const limit = opts.limit ?? 100;

    // Keyset (not OFFSET) pagination on (timestamp, id) DESC: correct and index-friendly
    // even as this table grows without bound and rows are concurrently inserted —
    // exactly the property OFFSET-based paging lacks (see ADR-0015).
    let rows: AuditEventRow[];
    const cursor = opts.before ? await this.pool.query<{ timestamp: string; id: string }>(
      `SELECT "timestamp", id FROM audit_events WHERE id = $1`,
      [opts.before]
    ) : undefined;

    if (cursor && cursor.rows.length > 0) {
      const { timestamp, id } = cursor.rows[0]!;
      ({ rows } = await this.pool.query<AuditEventRow>(
        `SELECT * FROM audit_events WHERE ("timestamp", id) < ($1, $2) ORDER BY "timestamp" DESC, id DESC LIMIT $3`,
        [timestamp, id, limit]
      ));
    } else {
      // No cursor, or an unrecognized one: fail safe by starting from the newest event —
      // same fallback behavior as InMemoryRegistryStore.
      ({ rows } = await this.pool.query<AuditEventRow>(
        `SELECT * FROM audit_events ORDER BY "timestamp" DESC, id DESC LIMIT $1`,
        [limit]
      ));
    }

    const items = rows.map(auditEventRowToEvent);
    let nextCursor: string | undefined;
    if (items.length === limit) {
      const last = items[items.length - 1]!;
      const { rows: probe } = await this.pool.query(
        `SELECT 1 FROM audit_events WHERE ("timestamp", id) < ($1, $2) LIMIT 1`,
        [last.timestamp, last.id]
      );
      if (probe.length > 0) nextCursor = last.id;
    }

    return { items, nextCursor };
  }
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
