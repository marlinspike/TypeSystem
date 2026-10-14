import type { JsonSchema2020 } from "@typesys/core";

/**
 * JSON Schema 2020-12 to a TypeScript type expression, for the subset TypeSys
 * models author: primitives, `enum`/`const`, unions of `type`, arrays, nested
 * objects with `required` and `additionalProperties`, and `anyOf`/`oneOf`.
 * Anything it cannot express exactly (a `$ref`, a constraint TypeScript has no
 * word for) widens to `unknown` rather than claim a type the runtime does not
 * enforce. Used by `generateModel` and by `@typesys/cli`'s `generate-types`.
 */
export function schemaToTs(schema: JsonSchema2020 | boolean | undefined, indent = ""): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return union(schema.enum.map(literal));
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return union(variants.map((v) => schemaToTs(v, indent)));
  if (Array.isArray(schema.type)) return union(schema.type.map((t) => schemaToTs({ ...schema, type: t }, indent)));
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrap(schemaToTs(schema.items, indent))}[]`;
    case "object":
      return objectToTs(schema, indent);
    default:
      return "unknown";
  }
}

/** The members of an object schema, one per line at `indent + 2`; `optionalAll` marks every member optional. */
export function propertiesToTs(
  properties: Record<string, JsonSchema2020> | undefined,
  required: readonly string[] | undefined,
  indent: string,
  optionalAll = false
): string[] {
  const requiredSet = new Set(required ?? []);
  const inner = `${indent}  `;
  return Object.entries(properties ?? {}).map(([name, propSchema]) => {
    const optional = optionalAll || !requiredSet.has(name) ? "?" : "";
    const doc = propSchema.description ? `${inner}/** ${propSchema.description.replaceAll("*/", "*\\/")} */\n` : "";
    return `${doc}${inner}${propertyKey(name)}${optional}: ${schemaToTs(propSchema, inner)};`;
  });
}

function objectToTs(schema: JsonSchema2020, indent: string): string {
  const members = propertiesToTs(schema.properties, schema.required, indent);
  const extra = schema.additionalProperties;
  if (extra !== undefined && extra !== false) members.push(`${indent}  [key: string]: ${extra === true ? "unknown" : schemaToTs(extra, `${indent}  `)};`);
  if (members.length === 0) return extra === false ? "Record<never, never>" : "Record<string, unknown>";
  return `{\n${members.join("\n")}\n${indent}}`;
}

export function propertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? JSON.stringify(value) : "unknown";
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.includes("unknown")) return "unknown";
  return unique.length === 0 ? "never" : unique.join(" | ");
}

/** Parenthesizes anything holding a union before `[]` binds to it; the parentheses are harmless where the union is nested. */
function wrap(type: string): string {
  return type.includes(" | ") ? `(${type})` : type;
}
