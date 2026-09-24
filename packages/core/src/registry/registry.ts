import { ulid } from "ulid";
import type { Ajv2020 } from "ajv/dist/2020.js";
import { createSemanticValidator, SchemaValidationError } from "./validation.js";
import type { RegistryStore } from "./registry-store.js";
import type { SemanticTypeSchema, XRelationshipSpec, XRelationships } from "../model/vocabulary.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { TraitDefinition } from "../model/trait.js";
import type { ComputeContext } from "../model/context.js";
import type { JsonSchema2020 } from "../model/json-schema.js";
import type { DataSource, Mapping } from "../model/data-source.js";
import type { AuditEvent } from "../audit/audit-log.js";

export interface RegisterTypeOptions {
  name: string;
  version: string;
  extends?: string;
  traits?: TraitDefinition[];
  computedImplementations?: Record<string, (ctx: ComputeContext) => Promise<unknown>>;
  deprecated?: TypeDefinition["deprecated"];
  aliases?: Record<string, string>;
}

function toRelationshipDefinition(
  name: string,
  spec: XRelationshipSpec,
  sourceType: string,
  version: string
): RelationshipDefinition {
  return {
    id: ulid(),
    name,
    sourceType,
    targetType: spec.target,
    cardinality: spec.cardinality,
    inverseName: spec.inverse,
    edgeSchema: spec.edgeSchema,
    resolution: spec.resolution,
    version
  };
}

/**
 * The Semantic Registry: validates and stores Type/Relationship/Action
 * definitions, and owns the composition of `extends` + traits into a
 * flattened TypeDefinition at registration time (see ADR-0004).
 */
export class SemanticRegistry {
  private readonly ajv: Ajv2020;
  private readonly registeredSchemaIds = new Set<string>();

  constructor(
    private readonly store: RegistryStore,
    ajv: Ajv2020 = createSemanticValidator()
  ) {
    this.ajv = ajv;
  }

  private ensureAjvSchema(id: string, schema: JsonSchema2020): void {
    if (!this.registeredSchemaIds.has(id)) {
      this.ajv.addSchema({ ...schema, $id: id }, id);
      this.registeredSchemaIds.add(id);
    }
  }

  private traitSchemaId(traitName: string): string {
    return `https://typesys.dev/traits/${traitName}`;
  }

  async registerType(schema: SemanticTypeSchema, opts: RegisterTypeOptions): Promise<TypeDefinition> {
    const traits = opts.traits ?? [];

    let baseType: TypeDefinition | undefined;
    if (opts.extends) {
      baseType = await this.store.getType(opts.extends);
      if (!baseType) {
        throw new Error(`Cannot extend unknown type "${opts.extends}" (register base types before subtypes)`);
      }
      this.ensureAjvSchema(baseType.schema.$id, baseType.schema);
    }

    const allOf: JsonSchema2020[] = [];
    if (baseType) allOf.push({ $ref: baseType.schema.$id });
    for (const trait of traits) {
      const traitId = this.traitSchemaId(trait.name);
      this.ensureAjvSchema(traitId, trait.schema);
      allOf.push({ $ref: traitId });
    }

    const combinedAllOf = [...allOf, ...(schema.allOf ?? [])];
    const composedSchema: SemanticTypeSchema = {
      ...schema,
      ...(combinedAllOf.length > 0 ? { allOf: combinedAllOf } : {})
    };

    try {
      this.ensureAjvSchema(schema.$id, composedSchema);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SchemaValidationError(`Failed to compile schema for type "${opts.name}": ${detail}`, err);
    }

    // Merge relationships: base < trait < own (own wins on name collision).
    const relByName = new Map<string, RelationshipDefinition>();
    for (const r of baseType?.relationships ?? []) {
      relByName.set(r.name, { ...r, id: ulid(), sourceType: opts.name });
    }
    for (const trait of traits) {
      for (const [name, spec] of Object.entries(trait.relationships ?? ({} as XRelationships))) {
        relByName.set(name, toRelationshipDefinition(name, spec, opts.name, opts.version));
      }
    }
    for (const [name, spec] of Object.entries(schema["x-relationships"] ?? {})) {
      relByName.set(name, toRelationshipDefinition(name, spec, opts.name, opts.version));
    }
    const relationships = [...relByName.values()];

    // Merge action names: union of base, traits, own.
    const actionNames = new Set<string>(baseType?.actionNames ?? []);
    for (const trait of traits) for (const a of trait.actions?.actions ?? []) actionNames.add(a);
    for (const a of schema["x-actions"]?.actions ?? []) actionNames.add(a);

    // Merge computed properties: base < trait < own.
    const computedByName = new Map<string, ComputedPropertyDefinition>();
    for (const c of baseType?.computedProperties ?? []) computedByName.set(c.name, c);
    const computedImpls = opts.computedImplementations ?? {};
    const applyComputedSpecs = (specs: Record<string, { dependsOn: string[]; binding: string; resolutionMode?: "live" | "materialized" | "cached" }>) => {
      for (const [name, spec] of Object.entries(specs)) {
        const compute = computedImpls[spec.binding];
        if (!compute) {
          throw new Error(`No compute implementation registered for binding "${spec.binding}" (property "${name}" on type "${opts.name}")`);
        }
        computedByName.set(name, {
          name,
          dependsOn: spec.dependsOn,
          resolutionMode: spec.resolutionMode ?? "live",
          compute
        });
      }
    };
    for (const trait of traits) applyComputedSpecs(trait.computed ?? {});
    applyComputedSpecs(schema["x-computed"] ?? {});

    const typeDef: TypeDefinition = {
      id: ulid(),
      name: opts.name,
      version: opts.version,
      extends: opts.extends,
      traits: traits.map((t) => t.name),
      description: schema.description,
      schema: composedSchema,
      relationships,
      actionNames: [...actionNames],
      computedProperties: [...computedByName.values()],
      deprecated: opts.deprecated,
      aliases: opts.aliases
    };

    await this.store.putType(typeDef);
    for (const rel of relationships) await this.store.putRelationship(rel);

    return typeDef;
  }

  async registerAction(action: ActionDefinition): Promise<void> {
    await this.store.putAction(action);
  }

  async getType(name: string, versionRange?: string): Promise<TypeDefinition | undefined> {
    return this.store.getType(name, versionRange);
  }

  async listTypes(): Promise<TypeDefinition[]> {
    return this.store.listTypes();
  }

  async listTypeVersions(name: string): Promise<TypeDefinition[]> {
    return this.store.listTypeVersions(name);
  }

  async getAction(name: string, versionRange?: string): Promise<ActionDefinition | undefined> {
    return this.store.getAction(name, versionRange);
  }

  async listActions(): Promise<ActionDefinition[]> {
    return this.store.listActions();
  }

  async listRelationships(sourceType: string): Promise<RelationshipDefinition[]> {
    return this.store.listRelationships(sourceType);
  }

  /** Resolves an alias to its current property/relationship name, or returns the name unchanged. */
  resolveAlias(typeDef: TypeDefinition, name: string): string {
    return typeDef.aliases?.[name] ?? name;
  }

  async registerDataSource(ds: DataSource): Promise<void> {
    await this.store.putDataSource(ds);
  }

  async getDataSource(id: string): Promise<DataSource | undefined> {
    return this.store.getDataSource(id);
  }

  async registerMapping(mapping: Mapping): Promise<void> {
    await this.store.putMapping(mapping);
  }

  async listMappings(typeName: string): Promise<Mapping[]> {
    return this.store.listMappings(typeName);
  }

  async appendAuditEvent(evt: AuditEvent): Promise<void> {
    await this.store.appendAuditEvent(evt);
  }

  async listAuditEvents(): Promise<AuditEvent[]> {
    return this.store.listAuditEvents();
  }
}
