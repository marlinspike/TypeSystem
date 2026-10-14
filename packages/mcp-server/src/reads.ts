import type { Identity, JsonSchema2020, ProvenanceRef, ResolvedObject, SemanticRegistry, SemanticRuntime, TypeDefinition, TypeDescription } from "@typesys/core";

/**
 * The five reads MCP offers twice: as resources (ADR-0012) and as tools
 * (ADR-0051). Both handlers call these, so a read tool cannot drift from the
 * resource it mirrors — same runtime call, same arguments, same policy,
 * classification, audit, and errors.
 */

/**
 * Schema keywords the document carries no further: policy names and
 * markings, which no caller is told (ADR-0032, ADR-0068), and the
 * relationship, computed and Action specs, whose data sources and bindings
 * are the runtime's business (ADR-0056) and whose public part is in the
 * document's own `relationships`, `computedPropertyNames` and `actionNames`.
 */
const WITHHELD_KEYWORDS = new Set(["x-policy", "x-provenance", "x-relationships", "x-computed", "x-actions"]);

/**
 * A Type as MCP describes it: its own schema, relationships, Actions and
 * computed values, narrowed to `described`, the Type as
 * `SemanticRuntime.describeModel` gave it to this caller (ADR-0068).
 */
export function describeType(typeDef: TypeDefinition, described: TypeDescription) {
  const own = Object.fromEntries(Object.entries(typeDef.schema).filter(([k]) => !WITHHELD_KEYWORDS.has(k))) as JsonSchema2020;
  const members = new Set([...Object.keys(described.properties), ...described.relationships.map((r) => r.name), ...described.computed.map((c) => c.name)]);
  const schema: JsonSchema2020 = {
    ...own,
    ...(own.properties ? { properties: Object.fromEntries(Object.entries(own.properties).filter(([k]) => members.has(k))) } : {}),
    ...(own.required ? { required: own.required.filter((r) => members.has(r)) } : {})
  };
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: described.extends,
    traits: typeDef.traits,
    schema,
    relationships: typeDef.relationships
      .filter((r) => members.has(r.name))
      .map((r) => ({
        name: r.name,
        targetType: r.targetType,
        cardinality: r.cardinality,
        inverseName: r.inverseName
      })),
    // Every Action that applies to the Type, as the model gives it: one declared only by its own `applicableTypes` too.
    actionNames: described.actions,
    computedPropertyNames: described.computed.map((c) => c.name),
    deprecated: typeDef.deprecated,
    aliases: described.aliases
  };
}

export type TypeDocument = ReturnType<typeof describeType>;

export async function readTypes(registry: SemanticRegistry, runtime: SemanticRuntime, identity: Identity): Promise<TypeDocument[]> {
  const model = await runtime.describeModel(identity);
  const documents: TypeDocument[] = [];
  for (const described of model.types) {
    const typeDef = await registry.getType(described.name);
    if (typeDef) documents.push(describeType(typeDef, described));
  }
  return documents;
}

/** One Type, or the same "Unknown type" for one that does not exist and one this caller may not learn of. */
export async function readType(registry: SemanticRegistry, runtime: SemanticRuntime, typeName: string, identity: Identity): Promise<TypeDocument> {
  const described = (await runtime.describeModel(identity)).types.find((t) => t.name === typeName);
  const typeDef = described ? await registry.getType(typeName) : undefined;
  if (!described || !typeDef) throw new Error(`Unknown type "${typeName}"`);
  return describeType(typeDef, described);
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
