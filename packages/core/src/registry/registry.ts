import { ulid } from "ulid";
import type { Ajv2020 } from "ajv/dist/2020.js";
import { createSemanticValidator, SchemaValidationError } from "./validation.js";
import type { AuditEventListOptions, RegistryStore } from "./registry-store.js";
import type { SemanticTypeSchema, XRelationshipSpec, XComputed, XPolicy, XProvenance } from "../model/vocabulary.js";
import type { TypeDefinition, ComputedPropertyDefinition } from "../model/type.js";
import type { RelationshipDefinition } from "../model/relationship.js";
import type { ActionDefinition } from "../model/action.js";
import type { TraitDefinition } from "../model/trait.js";
import type { ComputeContext } from "../model/context.js";
import type { JsonSchema2020 } from "../model/json-schema.js";
import type { DataSource, Mapping } from "../model/data-source.js";
import type { QueryResult } from "../model/query.js";
import type { AuditEvent } from "../audit/audit-log.js";
import { latestFirst } from "./version-resolution.js";

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
    version,
    resolutionMode: spec.resolutionMode,
    cacheTtlMs: spec.cacheTtlMs
  };
}

/**
 * A subtype's access rules and markings, its base's included (ADR-0060).
 * Values a subtype inherits keep the base's protections: its property
 * policies and classifications are merged in, and the base's object policy
 * applies unless the subtype names its own. A subtype may add a policy or a
 * marking where the base has none; one that would replace the base's is
 * refused, since registration cannot tell a tighter rule from a looser one.
 * Before this, a subtype declaring only an object policy exposed every
 * protected value it inherited.
 */
function inheritProtections(name: string, base: TypeDefinition | undefined, own: SemanticTypeSchema): { policy?: XPolicy; provenance?: XProvenance } {
  const basePolicy = base?.schema["x-policy"];
  const baseProvenance = base?.schema["x-provenance"];
  const ownPolicy = own["x-policy"];
  const ownProvenance = own["x-provenance"];
  const refuse = (what: string) => {
    throw new SchemaValidationError(`Type "${name}" would replace ${what} it inherits from "${base!.name}"; a subtype may add protections, not replace them (ADR-0060)`, []);
  };

  const propertyPolicies = { ...basePolicy?.propertyPolicies };
  for (const [member, rule] of Object.entries(ownPolicy?.propertyPolicies ?? {})) {
    if (propertyPolicies[member] !== undefined && propertyPolicies[member] !== rule) refuse(`the policy "${propertyPolicies[member]}" on "${member}"`);
    propertyPolicies[member] = rule;
  }
  const objectPolicy = ownPolicy?.objectPolicy ?? basePolicy?.objectPolicy;
  const policy: XPolicy | undefined =
    objectPolicy !== undefined || Object.keys(propertyPolicies).length > 0
      ? { ...(objectPolicy !== undefined ? { objectPolicy } : {}), ...(Object.keys(propertyPolicies).length > 0 ? { propertyPolicies } : {}) }
      : undefined;

  const marking = ownProvenance?.defaultClassification;
  if (marking !== undefined && baseProvenance?.defaultClassification !== undefined && marking !== baseProvenance.defaultClassification)
    refuse(`the Type's classification "${baseProvenance.defaultClassification}"`);
  const properties: NonNullable<XProvenance["properties"]> = structuredClone(baseProvenance?.properties ?? {});
  for (const [member, spec] of Object.entries(ownProvenance?.properties ?? {})) {
    const inherited = properties[member]?.classification;
    if (inherited !== undefined && spec.classification !== undefined && spec.classification !== inherited) refuse(`the classification "${inherited}" on "${member}"`);
    properties[member] = { ...properties[member], ...spec, ...(inherited !== undefined ? { classification: inherited } : {}) };
  }
  const defaultClassification = marking ?? baseProvenance?.defaultClassification;
  const provenance: XProvenance | undefined =
    defaultClassification !== undefined || Object.keys(properties).length > 0
      ? { ...(defaultClassification !== undefined ? { defaultClassification } : {}), ...(Object.keys(properties).length > 0 ? { properties } : {}) }
      : undefined;
  return { ...(policy ? { policy } : {}), ...(provenance ? { provenance } : {}) };
}

/**
 * A registered subtype's protections over a new version of its base
 * (ADR-0060). A subtype's stored schema already holds what it inherited, so
 * whatever matches the old base is treated as inherited and follows the new
 * base where the new base still declares it; everything else is the
 * subtype's own and is kept, so a base that drops a protection does not drop
 * it from a subtype. A subtype's own rule that the new base would replace is
 * refused, as at the subtype's registration.
 */
function rederiveProtections(sub: TypeDefinition, oldBase: TypeDefinition | undefined, newBase: TypeDefinition): SemanticTypeSchema {
  const was = { policy: oldBase?.schema["x-policy"], provenance: oldBase?.schema["x-provenance"] };
  const now = { policy: newBase.schema["x-policy"], provenance: newBase.schema["x-provenance"] };
  const { "x-policy": subPolicy, "x-provenance": subProvenance, ...rest } = sub.schema;
  const inherited = (had: string | undefined, mine: string | undefined, next: string | undefined) => mine !== undefined && mine === had && next !== undefined;

  const propertyPolicies = { ...subPolicy?.propertyPolicies };
  for (const [member, rule] of Object.entries(propertyPolicies)) {
    if (inherited(was.policy?.propertyPolicies?.[member], rule, now.policy?.propertyPolicies?.[member])) delete propertyPolicies[member];
  }
  const objectPolicy = inherited(was.policy?.objectPolicy, subPolicy?.objectPolicy, now.policy?.objectPolicy) ? undefined : subPolicy?.objectPolicy;
  const properties: NonNullable<XProvenance["properties"]> = structuredClone(subProvenance?.properties ?? {});
  for (const [member, spec] of Object.entries(properties)) {
    if (inherited(was.provenance?.properties?.[member]?.classification, spec.classification, now.provenance?.properties?.[member]?.classification)) delete spec.classification;
  }
  const defaultClassification = inherited(was.provenance?.defaultClassification, subProvenance?.defaultClassification, now.provenance?.defaultClassification)
    ? undefined
    : subProvenance?.defaultClassification;
  const own: SemanticTypeSchema = {
    ...rest,
    "x-policy": { ...(objectPolicy !== undefined ? { objectPolicy } : {}), propertyPolicies },
    "x-provenance": { ...(defaultClassification !== undefined ? { defaultClassification } : {}), properties }
  };
  const { policy, provenance } = inheritProtections(sub.name, newBase, own);
  return { ...rest, ...(policy ? { "x-policy": policy } : {}), ...(provenance ? { "x-provenance": provenance } : {}) };
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

  /**
   * Returns a registered trait's raw property schema (the fragment merged
   * into every composing Type's `allOf`), or `undefined` if that trait
   * name has never been used in a `registerType` call yet. Needed by
   * codegen (`@typesys/cli`) to flatten a Type's own + inherited + trait
   * properties into one generated interface — `TypeDefinition` itself only
   * records trait *names*, not their schemas, since composition already
   * happened by the time registration finishes (see ADR-0004).
   */
  getTraitSchema(traitName: string): JsonSchema2020 | undefined {
    return this.ajv.getSchema(this.traitSchemaId(traitName))?.schema as JsonSchema2020 | undefined;
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
    const { policy, provenance } = inheritProtections(opts.name, baseType, schema);
    const composedSchema: SemanticTypeSchema = {
      ...schema,
      ...(combinedAllOf.length > 0 ? { allOf: combinedAllOf } : {}),
      ...(policy ? { "x-policy": policy } : {}),
      ...(provenance ? { "x-provenance": provenance } : {})
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
      for (const [name, spec] of Object.entries(trait.relationships ?? {})) {
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
    const applyComputedSpecs = (specs: XComputed) => {
      for (const [name, spec] of Object.entries(specs)) {
        const compute = computedImpls[spec.binding];
        if (!compute) {
          throw new Error(`No compute implementation registered for binding "${spec.binding}" (property "${name}" on type "${opts.name}")`);
        }
        const releases = spec.releases ?? [];
        const stray = releases.filter((r) => !spec.dependsOn.includes(r));
        if (stray.length > 0) {
          throw new Error(`Computed property "${name}" on type "${opts.name}" releases ${stray.map((r) => `"${r}"`).join(", ")}, which it does not depend on (ADR-0052)`);
        }
        if (spec.schema) {
          try {
            this.ajv.compile(spec.schema);
          } catch (err) {
            throw new SchemaValidationError(`Computed property "${name}" on type "${opts.name}" declares an invalid value schema: ${err instanceof Error ? err.message : String(err)}`, err);
          }
        }
        computedByName.set(name, {
          name,
          dependsOn: spec.dependsOn,
          ...(releases.length > 0 ? { releases: [...releases] } : {}),
          ...(spec.schema ? { schema: spec.schema } : {}),
          resolutionMode: spec.resolutionMode ?? "live",
          cacheTtlMs: spec.cacheTtlMs,
          binding: spec.binding,
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

    // Subtypes already registered against this Type keep its protections as they change (ADR-0060). Derived,
    // and any conflict refused, before anything is stored.
    const previous = await this.store.getType(opts.name);
    const becomesCurrent = latestFirst([...(await this.store.listTypeVersions(opts.name)).filter((v) => v.version !== opts.version), typeDef])[0] === typeDef;
    const subtypes = becomesCurrent ? await this.rederiveSubtypes(previous, typeDef) : [];

    await this.store.putType(typeDef);
    for (const rel of relationships) await this.store.putRelationship(rel);
    for (const sub of subtypes) await this.store.putType(sub);

    return typeDef;
  }

  /** Every registered version of every subtype of `base`, its protections re-derived over `next`, and theirs in turn. */
  private async rederiveSubtypes(base: TypeDefinition | undefined, next: TypeDefinition): Promise<TypeDefinition[]> {
    const out: TypeDefinition[] = [];
    for (const type of await this.store.listTypes()) {
      if (type.name === next.name) continue;
      const versions = await this.store.listTypeVersions(type.name);
      for (const [i, sub] of versions.entries()) {
        if (sub.extends !== next.name) continue;
        const schema = rederiveProtections(sub, base, next);
        if (JSON.stringify(schema) === JSON.stringify(sub.schema)) continue;
        const updated: TypeDefinition = { ...sub, schema };
        out.push(updated);
        // Its own subtypes extend its current version, as registration resolves `extends`.
        if (i === 0) out.push(...(await this.rederiveSubtypes(sub, updated)));
      }
    }
    return out;
  }

  async registerAction(action: ActionDefinition): Promise<void> {
    if (action.target) {
      const { idFrom, type } = action.target;
      const targetType = type ?? action.applicableTypes[0];
      if (!targetType || !action.applicableTypes.includes(targetType)) {
        throw new Error(`Action "${action.name}" targets "${String(targetType)}", which is not one of its applicableTypes (ADR-0053)`);
      }
      const idSchema = action.inputSchema.properties?.[idFrom];
      if (!action.inputSchema.required?.includes(idFrom) || idSchema?.type !== "string") {
        throw new Error(`Action "${action.name}" takes its target id from "${idFrom}", which must be a required string property of its inputSchema (ADR-0053)`);
      }
    }
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

  async listAuditEvents(opts?: AuditEventListOptions): Promise<QueryResult<AuditEvent>> {
    return this.store.listAuditEvents(opts);
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}
