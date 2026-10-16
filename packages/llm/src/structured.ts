import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { canonical, type JsonSchema2020 } from "@typesys/core";

/**
 * Whether a provider that enforces schemas strictly (OpenAI's strict mode,
 * Anthropic's structured outputs) can take `schema` as it is: every object
 * closed (`additionalProperties: false`) and every property required, and
 * no keyword those modes reject. Anything else is still asked for, as JSON
 * the instruction describes, and validated the same way afterwards.
 */
export function strictCompatible(schema: unknown, depth = 0): boolean {
  if (depth > 32 || !schema || typeof schema !== "object") return depth > 32 ? false : true;
  const s = schema as Record<string, unknown>;
  for (const k of ["patternProperties", "dependentSchemas", "if", "not", "unevaluatedProperties", "$ref", "$dynamicRef"]) if (k in s) return false;
  const type = s.type;
  const isObject = type === "object" || (Array.isArray(type) && type.includes("object")) || (type === undefined && typeof s.properties === "object");
  if (isObject) {
    if (s.additionalProperties !== false) return false;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [k, v] of Object.entries(props)) if (!required.has(k) || !strictCompatible(v, depth + 1)) return false;
  }
  if (s.items !== undefined && !strictCompatible(s.items, depth + 1)) return false;
  for (const k of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = s[k];
    if (Array.isArray(list) && !list.every((x) => strictCompatible(x, depth + 1))) return false;
  }
  for (const k of ["$defs", "definitions"]) {
    const defs = s[k];
    if (defs && typeof defs === "object" && !Object.values(defs).every((x) => strictCompatible(x, depth + 1))) return false;
  }
  return true;
}

/** The instruction that asks for JSON when the provider will not enforce the schema itself. */
export function jsonInstruction(schema: JsonSchema2020): string {
  return [
    "Answer with a single JSON value and nothing else: no prose, no code fence.",
    "It must satisfy this JSON Schema (2020-12):",
    JSON.stringify(schema)
  ].join("\n");
}

/** The JSON in a model's text: the whole of it, or the one fenced block or outermost object or array in it. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (Number.isFinite(first) && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      // the next candidate
    }
  }
  return { ok: false, problem: trimmed === "" ? "the answer is empty" : "the answer is not JSON" };
}

/** Schema validation, compiled once per distinct schema. Formats are checked; unknown keywords are ignored rather than refused, since domain schemas carry `x-` annotations. */
export class OutputValidator {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: true });
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor() {
    (addFormats as unknown as (ajv: Ajv2020) => void)(this.ajv);
  }

  /** The validator's problems with `value`, each a short sentence naming where; empty when it is valid. */
  problems(schema: JsonSchema2020, value: unknown): string[] {
    const key = canonical(schema);
    let validate = this.compiled.get(key);
    if (!validate) {
      try {
        validate = this.ajv.compile(schema as object);
      } catch (err) {
        return [`the schema itself cannot be compiled: ${(err as Error).message}`];
      }
      this.compiled.set(key, validate);
    }
    if (validate(value)) return [];
    return (validate.errors ?? []).slice(0, 20).map(describe);
  }
}

function describe(e: ErrorObject): string {
  const where = e.instancePath === "" ? "the answer" : e.instancePath;
  const extra = e.keyword === "additionalProperties" ? ` ("${String((e.params as { additionalProperty?: string }).additionalProperty)}")` : e.keyword === "enum" ? ` (one of ${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})` : "";
  return `${where} ${e.message ?? "is invalid"}${extra}`;
}
