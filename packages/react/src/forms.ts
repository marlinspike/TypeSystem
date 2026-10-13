import type { ActionDescription, JsonSchema2020 } from "@typesys/core";

export type FieldKind = "text" | "number" | "integer" | "boolean" | "select" | "date-time" | "json";

/** One input of an Action's form, read from its input schema. */
export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly description?: string;
  /** The allowed values of a `select`. */
  readonly options?: readonly (string | number | boolean)[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  /** Set on the input that names the object an instance-scoped Action acts on (ADR-0053), for a picker. */
  readonly objectOf?: string;
}

type Schema = Exclude<JsonSchema2020, boolean> & Record<string, unknown>;

/** `maintenanceEventId` → `Maintenance event id`. */
export function labelOf(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function kindOf(schema: Schema): FieldKind {
  if (Array.isArray(schema.enum) || "const" in schema) return "select";
  if (schema.type === "string") return schema.format === "date-time" ? "date-time" : "text";
  if (schema.type === "number") return "number";
  if (schema.type === "integer") return "integer";
  if (schema.type === "boolean") return "boolean";
  return "json";
}

/**
 * The fields of an Action's form, one per top-level input property, in
 * schema order (ADR-0058). It describes the input and decides nothing: what
 * the form submits is still validated and authorized by the runtime, which
 * `preview` asks before anything executes. Anything that is not a flat
 * scalar (an object, an array, a `$ref`) is a `json` field.
 */
export function formFields(action: Pick<ActionDescription, "inputSchema" | "target">): FormField[] {
  const input = action.inputSchema;
  const required = new Set(Array.isArray(input.required) ? (input.required) : []);
  const properties = (input.properties ?? {});
  return Object.entries(properties).map(([name, raw]) => {
    const schema = (typeof raw === "object" ? raw : {});
    const kind = kindOf(schema);
    const options = Array.isArray(schema.enum) ? (schema.enum as (string | number | boolean)[]) : "const" in schema ? [schema.const as string | number | boolean] : undefined;
    const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
    const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
    const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
    return {
      name,
      label: typeof schema.title === "string" ? schema.title : labelOf(name),
      kind,
      required: required.has(name),
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      ...(options ? { options } : {}),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(action.target?.idFrom === name ? { objectOf: action.target.type } : {})
    };
  });
}

export interface Coerced {
  /** The Action's input, ready for `preview` or `invoke`. */
  readonly value: Record<string, unknown>;
  /** Field name to what could not be read from it. The runtime still checks the rest. */
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * Turns what form controls hold (strings, and booleans from checkboxes) into
 * an Action's input. An empty control is left out, so a missing required
 * value is refused by the runtime with the schema's own message.
 */
export function coerceForm(fields: readonly FormField[], raw: Readonly<Record<string, unknown>>): Coerced {
  const value: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const v = raw[field.name];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") {
      value[field.name] = v;
      continue;
    }
    switch (field.kind) {
      case "number":
      case "integer": {
        const n = Number(v.trim());
        if (v.trim() === "" || !Number.isFinite(n) || (field.kind === "integer" && !Number.isInteger(n))) errors[field.name] = `Not ${field.kind === "integer" ? "a whole number" : "a number"}`;
        else value[field.name] = n;
        break;
      }
      case "boolean":
        if (v === "true" || v === "false") value[field.name] = v === "true";
        else errors[field.name] = "Not true or false";
        break;
      case "select": {
        const option = field.options?.find((o) => String(o) === v);
        if (option === undefined) errors[field.name] = "Not one of the options";
        else value[field.name] = option;
        break;
      }
      case "json":
        try {
          value[field.name] = JSON.parse(v) as unknown;
        } catch {
          errors[field.name] = "Not valid JSON";
        }
        break;
      default:
        value[field.name] = v;
    }
  }
  return { value, errors };
}
