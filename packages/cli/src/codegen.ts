import type { SemanticRegistry, TypeDefinition, JsonSchema2020 } from "@typesys/core";

/**
 * Generates TypeScript interfaces from registered Types — the "generated
 * client types" the mission brief called for and this project never
 * built until now. Deliberately not a general JSON Schema → TypeScript
 * compiler: it covers exactly the subset this project's schemas actually
 * use (flat primitives, enums, arrays, and the `extends`/trait composition
 * model from ADR-0004), which is both simpler and more correct for THIS
 * codebase than depending on a generic converter that would have to guess
 * at `x-relationships`/`x-computed`/`allOf`-of-registered-$ref semantics
 * it was never designed to understand.
 *
 * Relationships and Actions are documented in a header comment, not
 * emitted as fields — embedding them would blur the exact "properties vs.
 * relationships vs. actions" distinction this whole system exists to
 * enforce (see ADR-0003/0005).
 */

function pascalCase(name: string): string {
  const short = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

function primitiveTs(type: unknown): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function propertyType(schema: JsonSchema2020): string {
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(schema.type)) return [...new Set(schema.type.map(primitiveTs))].join(" | ");
  if (schema.type === "array") return `${schema.items ? propertyType(schema.items) : "unknown"}[]`;
  if (schema.type === "object") return "Record<string, unknown>"; // nested objects: not used by this project's schemas today
  return primitiveTs(schema.type);
}

function propertyLines(properties: Record<string, JsonSchema2020> | undefined, required: string[] | undefined): string[] {
  const requiredSet = new Set(required ?? []);
  return Object.entries(properties ?? {}).map(([name, propSchema]) => {
    const optional = requiredSet.has(name) ? "" : "?";
    const comment = propSchema.description ? `  /** ${propSchema.description} */\n` : "";
    return `${comment}  ${name}${optional}: ${propertyType(propSchema)};`;
  });
}

/** A trait's own property fragment as a standalone interface, reused via `extends` by every composing Type. */
export function generateTraitInterface(traitName: string, schema: JsonSchema2020): string | undefined {
  const lines = propertyLines(schema.properties, schema.required);
  if (lines.length === 0) return undefined; // e.g. Geolocatable/Ownable contribute relationships, not properties
  return `export interface ${traitName} {\n${lines.join("\n")}\n}\n`;
}

export function generateTypeInterface(typeDef: TypeDefinition, registry: SemanticRegistry): string {
  const interfaceName = pascalCase(typeDef.name);
  const ownLines = propertyLines(typeDef.schema.properties, typeDef.schema.required);
  const computedLines = typeDef.computedProperties.map(
    (cp) => `  /** computed — depends on: ${cp.dependsOn.join(", ")} */\n  ${cp.name}?: unknown;`
  );

  const extendsClause: string[] = [];
  if (typeDef.extends) extendsClause.push(pascalCase(typeDef.extends));
  for (const traitName of typeDef.traits ?? []) {
    const traitSchema = registry.getTraitSchema(traitName);
    if (traitSchema?.properties && Object.keys(traitSchema.properties).length > 0) {
      extendsClause.push(traitName);
    }
  }

  const docLines = [`${typeDef.name}@${typeDef.version}${typeDef.description ? ` — ${typeDef.description}` : ""}`];
  if (typeDef.relationships.length) {
    docLines.push(`Relationships (navigate via the runtime, not inline fields): ${typeDef.relationships.map((r) => r.name).join(", ")}.`);
  }
  if (typeDef.actionNames.length) {
    docLines.push(`Actions: ${typeDef.actionNames.join(", ")}.`);
  }
  const header = `/**\n${docLines.map((l) => ` * ${l}`).join("\n")}\n */\n`;

  const extendsStr = extendsClause.length ? ` extends ${extendsClause.join(", ")}` : "";
  const body = [...ownLines, ...computedLines].join("\n") || "  // (no own properties)";

  return `${header}export interface ${interfaceName}${extendsStr} {\n${body}\n}\n`;
}

/**
 * Generates one self-contained `.ts` module for every currently registered
 * Type (plus every trait any of them use). Always operates on the full
 * registry rather than a caller-chosen subset: an `extends`/trait target
 * left out would generate an interface referencing an undefined name, so
 * completeness here is what keeps the output always valid TypeScript.
 */
export async function generateModule(registry: SemanticRegistry): Promise<string> {
  const types = await registry.listTypes();
  const traitBlocks = new Map<string, string>();

  for (const typeDef of types) {
    for (const traitName of typeDef.traits ?? []) {
      if (traitBlocks.has(traitName)) continue;
      const traitSchema = registry.getTraitSchema(traitName);
      const block = traitSchema ? generateTraitInterface(traitName, traitSchema) : undefined;
      if (block) traitBlocks.set(traitName, block);
    }
  }

  const typeBlocks = types.map((t) => generateTypeInterface(t, registry));
  const header = `// GENERATED by \`typesys generate-types\` — do not edit by hand.\n\n`;
  return header + [...traitBlocks.values(), ...typeBlocks].join("\n");
}
