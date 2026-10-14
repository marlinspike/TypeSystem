import type { JsonSchema2020, ModelDescription } from "@typesys/core";

/** A schema keyword `synthesize` cannot honor, so it refuses rather than return a value the schema may reject. */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

/** mulberry32: small, fast, and the same sequence for the same seed on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];

type Schema = JsonSchema2020 & Record<string, unknown>;

class Synthesizer {
  private readonly next: () => number;

  constructor(
    seed: number,
    private readonly root: Schema
  ) {
    this.next = rng(seed);
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  private pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith("#/")) throw new UnsupportedSchemaError(`$ref "${ref}" is not a local reference`);
    let node: unknown = this.root;
    for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (!node || typeof node !== "object") throw new UnsupportedSchemaError(`$ref "${ref}" names nothing`);
    return node as Schema;
  }

  value(schema: Schema, depth = 0): unknown {
    if (depth > 16) throw new UnsupportedSchemaError("schema nests deeper than 16 levels");
    for (const keyword of ["pattern", "not", "if", "patternProperties", "uniqueItems", "multipleOf", "dependentSchemas", "propertyNames"]) {
      if (keyword in schema) throw new UnsupportedSchemaError(`keyword "${keyword}" is not supported`);
    }
    if (typeof schema.$ref === "string") return this.value(this.resolve(schema.$ref), depth + 1);
    if ("const" in schema) return structuredClone(schema.const);
    if (Array.isArray(schema.enum)) return structuredClone(this.pick(schema.enum));
    if (Array.isArray(schema.oneOf)) return this.value(schema.oneOf[0] as Schema, depth + 1);
    if (Array.isArray(schema.anyOf)) return this.value(this.pick(schema.anyOf), depth + 1);
    if (Array.isArray(schema.allOf)) {
      const merged: Schema = { ...schema };
      delete merged.allOf;
      for (const part of schema.allOf as Schema[]) Object.assign(merged, part);
      return this.value(merged, depth + 1);
    }
    const declared = schema.type;
    const type = Array.isArray(declared) ? (declared.find((t) => t !== "null") ?? "null") : (declared ?? (schema.properties ? "object" : "string"));
    switch (type) {
      case "object":
        return this.object(schema, depth);
      case "array": {
        const min = typeof schema.minItems === "number" ? schema.minItems : 0;
        const max = typeof schema.maxItems === "number" ? schema.maxItems : min + 3;
        const items = (schema.items ?? {});
        return Array.from({ length: this.int(min, Math.max(min, Math.min(max, min + 3))) }, () => this.value(items, depth + 1));
      }
      case "string":
        return this.string(schema);
      case "integer":
      case "number":
        return this.number(schema, type === "integer");
      case "boolean":
        return this.next() < 0.5;
      case "null":
        return null;
      default:
        throw new UnsupportedSchemaError(`type "${String(type)}" is not supported`);
    }
  }

  private object(schema: Schema, depth: number): Record<string, unknown> {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const out: Record<string, unknown> = {};
    // Every declared property, so a synthetic object exercises every value a reader could ask for.
    for (const [name, propertySchema] of Object.entries(properties)) out[name] = this.value(propertySchema, depth + 1);
    for (const name of (schema.required ?? [])) if (!(name in out)) out[name] = this.word();
    return out;
  }

  private word(): string {
    return `${this.pick(WORDS)}-${this.int(100, 999)}`;
  }

  private string(schema: Schema): string {
    switch (schema.format) {
      case "date-time":
        return new Date(Date.UTC(2026, 0, 1) + this.int(0, 365 * 24) * 3_600_000).toISOString();
      case "date":
        return new Date(Date.UTC(2026, 0, 1) + this.int(0, 365) * 86_400_000).toISOString().slice(0, 10);
      case "email":
        return `${this.pick(WORDS)}${this.int(1, 99)}@example.test`;
      case "uuid": {
        const hex = () => this.int(0, 15).toString(16);
        const part = (n: number) => Array.from({ length: n }, hex).join("");
        return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
      }
      case "uri":
        return `https://example.test/${this.pick(WORDS)}`;
      case undefined:
        break;
      default:
        throw new UnsupportedSchemaError(`string format "${String(schema.format)}" is not supported`);
    }
    const min = typeof schema.minLength === "number" ? schema.minLength : 0;
    const max = typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
    let text = this.word();
    while (text.length < min) text += `-${this.word()}`;
    return text.slice(0, max);
  }

  private number(schema: Schema, integer: boolean): number {
    const lo = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : typeof schema.minimum === "number" ? schema.minimum : 0;
    const hi = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : typeof schema.maximum === "number" ? schema.maximum : lo + 1000;
    if (integer) {
      const min = Math.ceil(typeof schema.exclusiveMinimum === "number" ? lo + 1e-9 : lo);
      const max = Math.floor(typeof schema.exclusiveMaximum === "number" ? hi - 1e-9 : hi);
      if (min > max) throw new UnsupportedSchemaError("no integer lies within the declared bounds");
      return this.int(min, max);
    }
    // Strictly inside the bounds, so an exclusive bound is never hit.
    return lo + (hi - lo) * (0.001 + 0.998 * this.next());
  }
}

/**
 * A value `schema` admits, the same for the same seed (ADR-0057). It covers
 * the JSON Schema a TypeSys model uses for values and Action outputs; a keyword
 * it cannot honor (`pattern`, `not`, ...) is refused with
 * `UnsupportedSchemaError` rather than guessed at.
 */
export function synthesize(schema: JsonSchema2020, seed = 1): unknown {
  return new Synthesizer(seed, schema).value(schema);
}

/**
 * `count` synthetic objects of one Type, shaped as an adapter seeds them
 * (`{ objectId, values }`), every stored value from its composed schema. For
 * running a workflow, a query or a load test against data that looks like the
 * model's without being anyone's.
 */
export function synthesizeObjects(
  model: ModelDescription,
  typeName: string,
  count: number,
  seed = 1
): { objectId: string; values: Record<string, unknown> }[] {
  const type = model.types.find((t) => t.name === typeName);
  if (!type) throw new UnsupportedSchemaError(`unknown Type "${typeName}"`);
  const prefix = typeName.split(".").pop()!.slice(0, 3).toUpperCase();
  const objectSchema = { type: "object", properties: type.properties, required: type.required } as JsonSchema2020;
  return Array.from({ length: count }, (_, i) => {
    const objectId = `SYN-${prefix}-${String(i + 1).padStart(4, "0")}`;
    const values = synthesize(objectSchema, seed * 7919 + i) as Record<string, unknown>;
    if ("id" in type.properties) values.id = objectId;
    return { objectId, values };
  });
}
