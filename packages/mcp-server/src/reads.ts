import type { Identity, JsonSchema2020, ProvenanceRef, ResolvedObject, SemanticRegistry, SemanticRuntime, TypeDefinition, TypeDescription } from "@typesys/core";

/**
 * The five reads MCP offers twice: as resources (ADR-0012) and as tools
 * (ADR-0051). Both handlers call these, so a read tool cannot drift from the
 * resource it mirrors — same runtime call, same arguments, same policy,
 * classification, audit, and errors.
 */

/**
 * The schema keywords a Type document carries (ADR-0068), an allowlist:
 * everything else stays behind. That covers policy names and markings, which
 * no caller is told (ADR-0032), the relationship, computed and Action specs,
 * whose data sources and bindings are the runtime's business (ADR-0056) and
 * whose public part is in the document's own `relationships`,
 * `computedPropertyNames` and `actionNames`, and any keyword that could name
 * a Type this caller is not told of.
 */
const DOCUMENT_KEYWORDS = new Set(["$schema", "$id", "title", "description", "type", "properties", "required", "additionalProperties", "allOf", "examples", "$comment"]);

/**
 * A Type as MCP describes it: its own schema, relationships, Actions and
 * computed values, narrowed to `described`, the Type as
 * `SemanticRuntime.describeModel` gave it to this caller (ADR-0068). Its
 * `allOf` keeps the base Type's `$ref` only when the base is described, a
 * trait's only when the trait is, and an inline entry only if it refers to
 * nothing.
 */
export function describeType(typeDef: TypeDefinition, described: TypeDescription, refs: { baseId?: string; traitIds?: ReadonlyMap<string, string> } = {}) {
  const own = Object.fromEntries(Object.entries(typeDef.schema).filter(([k]) => DOCUMENT_KEYWORDS.has(k))) as JsonSchema2020;
  const members = new Set([...Object.keys(described.properties), ...described.relationships.map((r) => r.name), ...described.computed.map((c) => c.name)]);
  const allowedRefs = new Set([
    ...(described.extends && refs.baseId ? [refs.baseId] : []),
    ...described.traits.flatMap((t) => (refs.traitIds?.get(t) ? [refs.traitIds.get(t)!] : []))
  ]);
  const allOf = (own.allOf ?? []).filter((entry) => {
    const ref = (entry as { $ref?: unknown }).$ref;
    if (typeof ref === "string") return allowedRefs.has(ref) && Object.keys(entry).length === 1;
    return !JSON.stringify(entry).includes('"$ref"');
  });
  const { allOf: _all, examples, ...rest } = own;
  // An example is a value of the Type: it keeps only the members described, and one that is not an object is dropped.
  const narrowedExamples = Array.isArray(examples)
    ? examples.flatMap((e: unknown) => (e !== null && typeof e === "object" && !Array.isArray(e) ? [Object.fromEntries(Object.entries(e).filter(([k]) => members.has(k)))] : []))
    : [];
  const schema: JsonSchema2020 = {
    ...rest,
    ...(narrowedExamples.length > 0 ? { examples: narrowedExamples } : {}),
    // Each property as described: a reference to a withheld Type is already replaced there.
    ...(own.properties ? { properties: Object.fromEntries(Object.entries(own.properties).filter(([k]) => members.has(k)).map(([k, v]) => [k, described.properties[k] ?? v])) } : {}),
    ...(own.required ? { required: own.required.filter((r) => members.has(r)) } : {}),
    ...(allOf.length > 0 ? { allOf } : {})
  };
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: described.extends,
    traits: described.traits,
    schema,
    relationships: typeDef.relationships
      .filter((r) => members.has(r.name))
      .map((r) => ({
        name: r.name,
        targetType: r.targetType,
        cardinality: r.cardinality,
        // The inverse only when it is described too: it names a relationship of its own.
        inverseName: r.inverseName !== undefined && members.has(r.inverseName) ? r.inverseName : undefined
      })),
    // Every Action that applies to the Type, as the model gives it: one declared only by its own `applicableTypes` too.
    actionNames: described.actions,
    computedPropertyNames: described.computed.map((c) => c.name),
    deprecated: described.deprecated,
    aliases: described.aliases
  };
}

/** The `$id` of the Type's base, and of each of its traits, to recognize them in its `allOf`. */
async function refsOf(registry: SemanticRegistry, typeDef: TypeDefinition): Promise<{ baseId?: string; traitIds: Map<string, string> }> {
  const base = typeDef.extends ? await registry.getType(typeDef.extends) : undefined;
  const traitIds = new Map<string, string>();
  for (const t of typeDef.traits ?? []) {
    const id = registry.getTraitSchema(t)?.$id;
    if (typeof id === "string") traitIds.set(t, id);
  }
  return { ...(typeof base?.schema.$id === "string" ? { baseId: base.schema.$id } : {}), traitIds };
}

export type TypeDocument = ReturnType<typeof describeType>;

export async function readTypes(registry: SemanticRegistry, runtime: SemanticRuntime, identity: Identity): Promise<TypeDocument[]> {
  const model = await runtime.describeModel(identity);
  const documents: TypeDocument[] = [];
  for (const described of model.types) {
    const typeDef = await registry.getType(described.name);
    if (typeDef) documents.push(describeType(typeDef, described, await refsOf(registry, typeDef)));
  }
  return documents;
}

/** One Type, or the same "Unknown type" for one that does not exist and one this caller may not learn of. */
export async function readType(registry: SemanticRegistry, runtime: SemanticRuntime, typeName: string, identity: Identity): Promise<TypeDocument> {
  const described = (await runtime.describeModel(identity)).types.find((t) => t.name === typeName);
  const typeDef = described ? await registry.getType(typeName) : undefined;
  if (!described || !typeDef) throw new Error(`Unknown type "${typeName}"`);
  return describeType(typeDef, described, await refsOf(registry, typeDef));
}

export function readObject(runtime: SemanticRuntime, typeName: string, objectId: string, identity: Identity): Promise<ResolvedObject> {
  return runtime.getObject(typeName, objectId, identity, { includeProvenance: true });
}

export function readRelationship(
  runtime: SemanticRuntime,
  typeName: string,
  objectId: string,
  relationshipName: string,
  identity: Identity
): Promise<ResolvedObject[]> {
  return runtime.getRelationship(typeName, objectId, relationshipName, identity);
}

export function readProvenance(
  runtime: SemanticRuntime,
  typeName: string,
  objectId: string,
  propertyPath: string,
  identity: Identity
): Promise<ProvenanceRef[]> {
  return runtime.getProvenance(typeName, objectId, propertyPath, identity);
}
