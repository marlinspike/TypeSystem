import type { Identity, ProvenanceRef, ResolvedObject, SemanticRegistry, SemanticRuntime, TypeDefinition } from "@typesys/core";

/**
 * The five reads MCP offers twice: as resources (ADR-0012) and as tools
 * (ADR-0051). Both handlers call these, so a read tool cannot drift from the
 * resource it mirrors — same runtime call, same arguments, same policy,
 * classification, audit, and errors.
 */

export function describeType(typeDef: TypeDefinition) {
  return {
    name: typeDef.name,
    version: typeDef.version,
    description: typeDef.description,
    extends: typeDef.extends,
    traits: typeDef.traits,
    schema: typeDef.schema,
    relationships: typeDef.relationships.map((r) => ({
      name: r.name,
      targetType: r.targetType,
      cardinality: r.cardinality,
      inverseName: r.inverseName
    })),
    actionNames: typeDef.actionNames,
    computedPropertyNames: typeDef.computedProperties.map((c) => c.name),
    deprecated: typeDef.deprecated,
    aliases: typeDef.aliases
  };
}

export type TypeDocument = ReturnType<typeof describeType>;

export async function readTypes(registry: SemanticRegistry): Promise<TypeDocument[]> {
  return (await registry.listTypes()).map(describeType);
}

export async function readType(registry: SemanticRegistry, typeName: string): Promise<TypeDocument> {
  const typeDef = await registry.getType(typeName);
  if (!typeDef) throw new Error(`Unknown type "${typeName}"`);
  return describeType(typeDef);
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
