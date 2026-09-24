import type { SemanticRegistry, RegisterTypeOptions } from "./registry.js";
import type { SemanticTypeSchema } from "../model/vocabulary.js";
import type { ActionDefinition } from "../model/action.js";
import type { DataSource, Mapping } from "../model/data-source.js";

export interface DomainTypeEntry {
  schema: SemanticTypeSchema;
  options: RegisterTypeOptions;
}

/**
 * A domain package's complete registration payload. Registering a new
 * domain (e.g. Hospital, Factory) requires authoring exactly this shape and
 * calling `registerDomain` — zero changes to the runtime (see ADR-0013).
 */
export interface DomainManifest {
  domain: string;
  types: DomainTypeEntry[];
  actions?: ActionDefinition[];
  dataSources?: DataSource[];
  mappings?: Mapping[];
}

export async function registerDomain(registry: SemanticRegistry, manifest: DomainManifest): Promise<void> {
  for (const dataSource of manifest.dataSources ?? []) {
    await registry.registerDataSource(dataSource);
  }
  // Types must register in manifest order so `extends` targets are already registered.
  for (const entry of manifest.types) {
    await registry.registerType(entry.schema, entry.options);
  }
  for (const action of manifest.actions ?? []) {
    await registry.registerAction(action);
  }
  for (const mapping of manifest.mappings ?? []) {
    await registry.registerMapping(mapping);
  }
}
