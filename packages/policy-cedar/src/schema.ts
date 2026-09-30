import { schemaToJson, type DetailedError, type Schema, type TypeOfAttribute } from "@cedar-policy/cedar-wasm/nodejs";
import { CedarPolicyError } from "./errors.js";
import { PRINCIPAL_TYPE, ROLE_TYPE, type AttributeIndex } from "./mapping.js";

export function messagesOf(errors: DetailedError[]): string[] {
  return errors.map((e) => e.message);
}

/** A name used inside namespace `ns`, fully qualified: `User` in `TypeS` is `TypeS::User`; `hospital::Patient` stays as it is. */
function qualify(ns: string, name: string): string {
  return name.includes("::") || ns === "" ? name : `${ns}::${name}`;
}

/**
 * Parses the schema into the index of what a policy may see — each entity
 * type's declared attribute names — and enforces the engine's structural
 * rules (ADR-0031): `TypeS::User` and `TypeS::Role` exist, a user can be a
 * member of a role, and every resource attribute is optional, because a
 * type-level request carries none (ADR-0030). Throws `CedarPolicyError`
 * listing every problem at once.
 */
export function indexSchema(schema: Schema): AttributeIndex {
  const parsed = schemaToJson(schema);
  if (parsed.type === "failure") throw new CedarPolicyError("The Cedar schema failed to parse", messagesOf(parsed.errors));

  const index = new Map<string, Set<string>>();
  const requiredAttributes = new Map<string, string[]>();
  const memberOf = new Map<string, string[]>();
  const resourceTypes = new Set<string>();
  const problems: string[] = [];

  for (const [ns, definition] of Object.entries(parsed.json)) {
    for (const [name, entityType] of Object.entries(definition.entityTypes)) {
      const type = qualify(ns, name);
      const shape = "shape" in entityType ? entityType.shape : undefined;
      if (shape && !("attributes" in shape)) {
        problems.push(`entity type ${type}: only an inline record shape is supported`);
        continue;
      }
      const attributes: Record<string, TypeOfAttribute<string>> = shape && "attributes" in shape ? (shape.attributes as Record<string, TypeOfAttribute<string>>) : {};
      index.set(type, new Set(Object.keys(attributes)));
      requiredAttributes.set(type, Object.entries(attributes).filter(([, a]) => a.required !== false).map(([a]) => a));
      memberOf.set(type, ("memberOfTypes" in entityType ? (entityType.memberOfTypes ?? []) : []).map((m) => qualify(ns, m)));
    }
    for (const action of Object.values(definition.actions)) {
      for (const resourceType of action.appliesTo?.resourceTypes ?? []) resourceTypes.add(qualify(ns, resourceType));
    }
  }

  for (const required of [PRINCIPAL_TYPE, ROLE_TYPE]) {
    if (!index.has(required)) problems.push(`the schema must declare entity type ${required}`);
  }
  if (index.has(PRINCIPAL_TYPE) && !memberOf.get(PRINCIPAL_TYPE)?.includes(ROLE_TYPE)) {
    problems.push(`${PRINCIPAL_TYPE} must be declared \`in [Role]\`, so a subject's roles can be its parents`);
  }
  for (const resourceType of resourceTypes) {
    for (const attribute of requiredAttributes.get(resourceType) ?? []) {
      problems.push(`resource attribute ${resourceType}.${attribute} must be optional (\`${attribute}?\`): a type-level request carries no attributes`);
    }
  }

  if (problems.length > 0) throw new CedarPolicyError("The Cedar schema breaks the engine's rules", problems);
  return index;
}
