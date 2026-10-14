import type { ActionDescription, JsonSchema2020, ModelDescription, TypeDescription } from "@typesys/core";
import { schemaToTs } from "@typesys/sdk";

/** One schema as a single-line type: nested objects collapse to `object`, so a catalog line stays a line. */
export function compactType(schema: JsonSchema2020 | undefined): string {
  const ts = schemaToTs(schema);
  return ts.includes("\n") ? (schema?.type === "array" ? "object[]" : "object") : ts;
}

function fields(properties: Record<string, JsonSchema2020>, required?: readonly string[]): string {
  const req = new Set(required ?? []);
  return Object.entries(properties)
    .map(([name, s]) => `${name}${required && !req.has(name) ? "?" : ""}: ${compactType(s)}`)
    .join(", ");
}

/**
 * A Type as a few lines an agent can read in one pass (ADR-0056): its
 * values, what it relates to, and the Actions on it. Every value is listed
 * as present; whether a caller may read it is the runtime's decision.
 */
export function describeTypeCompactly(type: TypeDescription): string {
  const lines = [`${type.name}${type.description ? ` — ${type.description}` : ""}`];
  lines.push(`  values: ${fields(type.properties)}`);
  if (type.computed.length > 0) lines.push(`  computed: ${type.computed.map((c) => `${c.name}: ${compactType(c.schema)}`).join(", ")}`);
  if (type.relationships.length > 0) {
    lines.push(`  relationships: ${type.relationships.map((r) => `${r.name} → ${r.target}${r.cardinality.endsWith("-to-many") ? "[]" : ""}`).join(", ")}`);
  }
  if (type.actions.length > 0) lines.push(`  actions: ${type.actions.join(", ")}`);
  if (type.deprecated) lines.push(`  deprecated since ${type.deprecated.since}${type.deprecated.supersededBy ? `, use ${type.deprecated.supersededBy}` : ""}`);
  return lines.join("\n");
}

export function describeActionCompactly(action: ActionDescription): string {
  const scope = action.target ? `on one ${action.target.type} (id in ${action.target.idFrom})` : `on ${action.applicableTypes.join(", ")}`;
  return [
    `${action.name} — ${action.description}`,
    `  ${scope}; ${action.sideEffects === "none" ? "reads only" : action.sideEffects}; idempotency ${action.idempotency}`,
    `  input: { ${fields(action.inputSchema.properties ?? {}, action.inputSchema.required ?? [])} }`
  ].join("\n");
}

/** The whole model, compactly: every Type, then every Action. */
export function compactCatalog(model: ModelDescription): string {
  return [...model.types.map(describeTypeCompactly), ...model.actions.map(describeActionCompactly)].join("\n");
}
