import semver from "semver";
import type { RegistryStore } from "./registry-store.js";
import type { TypeDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { DataSource, Mapping } from "../model/data-source.js";
import type { AuditEvent } from "../audit/audit-log.js";

function latestFirst<T extends { version: string }>(versions: T[]): T[] {
  return [...versions].sort((a, b) => semver.rcompare(a.version, b.version));
}

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
    const versions = latestFirst(this.types.get(name) ?? []);
    if (versions.length === 0) return undefined;
    if (!versionRange) return versions[0];
    return versions.find((v) => semver.satisfies(v.version, versionRange));
  }

  async listTypeVersions(name: string): Promise<TypeDefinition[]> {
    return latestFirst(this.types.get(name) ?? []);
  }

  async listTypes(): Promise<TypeDefinition[]> {
    return [...this.types.values()].map((versions) => latestFirst(versions)[0]!);
  }

  async putRelationship(def: RelationshipDefinition): Promise<void> {
    const existing = this.relationships.get(def.sourceType) ?? [];
    this.relationships.set(def.sourceType, [
      ...existing.filter((r) => !(r.name === def.name && r.version === def.version)),
      def
    ]);
  }

  async listRelationships(sourceType: string): Promise<RelationshipDefinition[]> {
    return this.relationships.get(sourceType) ?? [];
  }

  async putAction(def: ActionDefinition): Promise<void> {
    const versions = this.actions.get(def.name) ?? [];
    this.actions.set(def.name, [...versions.filter((v) => v.version !== def.version), def]);
  }

  async getAction(name: string, versionRange?: string): Promise<ActionDefinition | undefined> {
    const versions = latestFirst(this.actions.get(name) ?? []);
    if (versions.length === 0) return undefined;
    if (!versionRange) return versions[0];
    return versions.find((v) => semver.satisfies(v.version, versionRange));
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

  async listAuditEvents(): Promise<AuditEvent[]> {
    return [...this.auditEvents];
  }
}
