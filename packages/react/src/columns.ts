import type { JsonSchema2020, TypeDescription } from "@typesys/core";
import { labelOf, type FieldKind } from "./forms.js";

/** One column of a table of a Type's objects. */
export interface Column {
  readonly key: string;
  readonly label: string;
  readonly kind: FieldKind;
  /** Stored values sort in the query; a computed one does not (ADR-0027). */
  readonly sortable: boolean;
  readonly computed: boolean;
  readonly description?: string;
  readonly options?: readonly (string | number | boolean)[];
}

function columnOf(key: string, raw: JsonSchema2020 | undefined, computed: boolean): Column {
  const schema = typeof raw === "object" ? raw : {};
  const kind: FieldKind = Array.isArray(schema.enum)
    ? "select"
    : schema.type === "string"
      ? schema.format === "date-time"
        ? "date-time"
        : "text"
      : schema.type === "number" || schema.type === "integer" || schema.type === "boolean"
        ? schema.type
        : "json";
  return {
    key,
    label: typeof schema.title === "string" ? schema.title : labelOf(key),
    kind,
    sortable: !computed && kind !== "json",
    computed,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(Array.isArray(schema.enum) ? { options: schema.enum as (string | number | boolean)[] } : {})
  };
}

/**
 * A Type's columns, stored then computed, or only `keys` in that order
 * (ADR-0058). A column describes a value; whether a caller sees it in a row
 * is still the runtime's answer, so a cell may be empty for one caller and
 * filled for another.
 */
export function columnsFor(type: Pick<TypeDescription, "properties" | "computed">, keys?: readonly string[]): Column[] {
  const all = [
    ...Object.entries(type.properties).map(([k, s]) => columnOf(k, s, false)),
    ...type.computed.map((c) => columnOf(c.name, c.schema, true))
  ];
  if (!keys) return all;
  return keys.map((k) => {
    const found = all.find((c) => c.key === k);
    if (!found) throw new Error(`No value "${k}" on this Type`);
    return found;
  });
}
