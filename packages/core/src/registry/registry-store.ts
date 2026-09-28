import type { TypeDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { DataSource, Mapping } from "../model/data-source.js";
import type { QueryResult } from "../model/query.js";
import type { AuditEvent } from "../audit/audit-log.js";

/**
 * The registry's own durable-metadata persistence seam (see ADR-0014 and,
 * for the production Postgres implementation, ADR-0015). The in-memory
 * implementation is the default and only backend required for tests/dev; a
 * Postgres implementation lives in a separate optional package, gated by
 * an env var, never a dependency of core.
 */
export interface RegistryStore {
  putType(def: TypeDefinition): Promise<void>;
  getType(name: string, versionRange?: string): Promise<TypeDefinition | undefined>;
  listTypeVersions(name: string): Promise<TypeDefinition[]>;
  listTypes(): Promise<TypeDefinition[]>;

  /** Upserts by (sourceType, name) — always "the current relationship," never versioned history (see ADR-0015). */
  putRelationship(def: RelationshipDefinition): Promise<void>;
  listRelationships(sourceType: string): Promise<RelationshipDefinition[]>;

  putAction(def: ActionDefinition): Promise<void>;
  getAction(name: string, versionRange?: string): Promise<ActionDefinition | undefined>;
  listActions(): Promise<ActionDefinition[]>;

  putDataSource(ds: DataSource): Promise<void>;
  getDataSource(id: string): Promise<DataSource | undefined>;

  putMapping(m: Mapping): Promise<void>;
  listMappings(typeName: string): Promise<Mapping[]>;

  appendAuditEvent(evt: AuditEvent): Promise<void>;
  /** Bounded and paginated — audit volume grows without limit, unlike every other list* method here (see ADR-0015). */
  listAuditEvents(opts?: { limit?: number; before?: string }): Promise<QueryResult<AuditEvent>>;

  /** Graceful shutdown. A no-op for the in-memory store; ends the pool for Postgres. */
  close?(): Promise<void>;
}
