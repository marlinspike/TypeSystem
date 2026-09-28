import type { RegistryStore } from "./registry-store.js";
import { latestFirst, resolveVersion } from "./version-resolution.js";
import type { TypeDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { DataSource, Mapping } from "../model/data-source.js";
import type { QueryResult } from "../model/query.js";
import type { AuditEvent } from "../audit/audit-log.js";

export class InMemoryRegistryStore implements RegistryStore {
  private readonly types = new Map<string, TypeDefinition[]>();
  private readonly relationships = new Map<string, RelationshipDefinition[]>();
  private readonly actions = new Map<string, ActionDefinition[]>();
  private readonly dataSources = new Map<string, DataSource>();
  private readonly mappings = new Map<string, Mapping[]>();
  private readonly auditEvents: AuditEvent[] = [];

  async putType(def: TypeDefinition): Promise<void> {
    const versions = this.types.get(def.name) ?? [];
    this.types.set(def.name, [...versions.filter((v) => v.version !== def.version), def]);
  }

  async getType(name: string, versionRange?: string): Promise<TypeDefinition | undefined> {
    return resolveVersion(this.types.get(name) ?? [], versionRange);
  }

  async listTypeVersions(name: string): Promise<TypeDefinition[]> {
    return latestFirst(this.types.get(name) ?? []);
  }

  async listTypes(): Promise<TypeDefinition[]> {
    return [...this.types.values()].map((versions) => latestFirst(versions)[0]!);
  }

  async putRelationship(def: RelationshipDefinition): Promise<void> {
    // Keyed by (sourceType, name), not (name, version): listRelationships has no
    // version parameter and only ever means "current" — re-registering a type at a
    // new version must replace its relationships, not accumulate stale ones (ADR-0015).
    const existing = this.relationships.get(def.sourceType) ?? [];
    this.relationships.set(def.sourceType, [...existing.filter((r) => r.name !== def.name), def]);
  }

  async listRelationships(sourceType: string): Promise<RelationshipDefinition[]> {
    return this.relationships.get(sourceType) ?? [];
  }

  async putAction(def: ActionDefinition): Promise<void> {
    const versions = this.actions.get(def.name) ?? [];
    this.actions.set(def.name, [...versions.filter((v) => v.version !== def.version), def]);
  }

  async getAction(name: string, versionRange?: string): Promise<ActionDefinition | undefined> {
    return resolveVersion(this.actions.get(name) ?? [], versionRange);
  }

  async listActions(): Promise<ActionDefinition[]> {
    return [...this.actions.values()].map((versions) => latestFirst(versions)[0]!);
  }

  async putDataSource(ds: DataSource): Promise<void> {
    this.dataSources.set(ds.id, ds);
  }

  async getDataSource(id: string): Promise<DataSource | undefined> {
    return this.dataSources.get(id);
  }

  async putMapping(m: Mapping): Promise<void> {
    const existing = this.mappings.get(m.typeName) ?? [];
    this.mappings.set(m.typeName, [...existing.filter((x) => x.id !== m.id), m]);
  }

  async listMappings(typeName: string): Promise<Mapping[]> {
    return this.mappings.get(typeName) ?? [];
  }

  async appendAuditEvent(evt: AuditEvent): Promise<void> {
    this.auditEvents.push(evt);
  }

  async listAuditEvents(opts: { limit?: number; before?: string } = {}): Promise<QueryResult<AuditEvent>> {
    const { limit = 100, before } = opts;
    // Newest first, by insertion order (append-only) — ids are ULIDs, so this
    // also happens to be lexicographic id order, but we don't rely on that here.
    const newestFirst = [...this.auditEvents].reverse();
    const startIndex = before ? newestFirst.findIndex((e) => e.id === before) + 1 : 0;
    const page = newestFirst.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < newestFirst.length ? page[page.length - 1]?.id : undefined;
    return { items: page, nextCursor };
  }

  async close(): Promise<void> {
    // No-op — kept for interface symmetry with PostgresRegistryStore (ADR-0015).
  }
}
