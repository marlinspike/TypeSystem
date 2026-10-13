import {
  InputValidator,
  type JsonSchema2020,
  type ModelDescription,
  type QueryFilter,
  type QueryInclude,
  type QueryLimits,
  type SemanticQuery,
  type TypeDescription
} from "@typesys/core";
import { didYouMean } from "./text.js";

export interface Diagnostic {
  /** `error`: the runtime refuses it, or it can never match. `warning`: it runs, but probably not as meant (a deprecated alias, a condition true of every object). */
  severity: "error" | "warning";
  code:
    | "invalid-query"
    | "unknown-type"
    | "unknown-property"
    | "unknown-relationship"
    | "computed-property"
    | "operator-never-matches"
    | "value-never-matches"
    | "always-matches"
    | "search-property"
    | "deprecated-alias"
    | "deprecated-type";
  /** A JSON Pointer into the query. */
  path: string;
  message: string;
  /** The name probably meant. */
  suggestion?: string;
}

type Kind = "string" | "number" | "boolean" | "array" | "object" | "null";

/** The kinds of value a schema admits; `undefined` when it cannot tell (no `type`, a `$ref`). */
function kinds(schema: JsonSchema2020 | undefined): Set<Kind> | undefined {
  if (!schema) return undefined;
  const values = schema.enum ?? (schema.const !== undefined ? [schema.const] : undefined);
  if (values) return new Set(values.map(kindOf));
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : undefined;
  return types ? new Set(types.map((t) => (t === "integer" ? "number" : t) as Kind)) : undefined;
}

function kindOf(value: unknown): Kind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Kind;
}

/** The operator's requirement on the property's kind, as the shared interpreter (`matchesFilter`) applies it. */
const OPERATOR_NEEDS: Partial<Record<string, Kind>> = { gt: "number", gte: "number", lt: "number", lte: "number", icontains: "string", contains: "array" };

class QueryChecker {
  readonly diagnostics: Diagnostic[] = [];
  private readonly types: Map<string, TypeDescription>;

  constructor(model: ModelDescription) {
    this.types = new Map(model.types.map((t) => [t.name, t]));
  }

  private report(d: Diagnostic): void {
    this.diagnostics.push(d);
  }

  type(name: string, path: string): TypeDescription | undefined {
    const type = this.types.get(name);
    if (!type) {
      const suggestion = didYouMean(name, this.types.keys());
      this.report({ severity: "error", code: "unknown-type", path, message: `No Type "${name}"`, ...(suggestion ? { suggestion } : {}) });
    } else if (type.deprecated) {
      this.report({ severity: "warning", code: "deprecated-type", path, message: `${name} is deprecated since ${type.deprecated.since}`, ...(type.deprecated.supersededBy ? { suggestion: type.deprecated.supersededBy } : {}) });
    }
    return type;
  }

  /** The schema of a stored or computed value; reports an unknown name. `allowComputed` false reports a computed one too. */
  value(type: TypeDescription, name: string, path: string, opts: { allowComputed: true; what: string } | { allowComputed: false; what: string; why: string }): JsonSchema2020 | undefined | null {
    if (name in type.properties) return type.properties[name];
    const computed = type.computed.find((c) => c.name === name);
    if (computed) {
      if (!opts.allowComputed) {
        this.report({ severity: "error", code: "computed-property", path, message: `${opts.what} cannot name the computed property "${name}": ${opts.why}` });
      }
      return computed.schema;
    }
    const candidates = [...Object.keys(type.properties), ...type.computed.map((c) => c.name)];
    const suggestion = didYouMean(name, candidates);
    this.report({ severity: "error", code: "unknown-property", path, message: `${type.name} has no value "${name}"`, ...(suggestion ? { suggestion } : {}) });
    return null;
  }

  filter(type: TypeDescription, filter: QueryFilter, path: string): void {
    if ("and" in filter) return filter.and.forEach((f, i) => this.filter(type, f, `${path}/and/${i}`));
    if ("or" in filter) return filter.or.forEach((f, i) => this.filter(type, f, `${path}/or/${i}`));
    const schema = this.value(type, filter.property, `${path}/property`, { allowComputed: true, what: "A filter" });
    if (schema === null) return;
    const admitted = kinds(schema);
    if (!admitted) return;
    const needs = OPERATOR_NEEDS[filter.operator];
    if (needs && !admitted.has(needs)) {
      this.report({
        severity: "error",
        code: "operator-never-matches",
        path: `${path}/operator`,
        message: `"${filter.operator}" matches only ${needs} values, and ${type.name}.${filter.property} is ${[...admitted].join(" or ")}`
      });
      return;
    }
    if (needs) return;
    const values = filter.operator === "in" ? (Array.isArray(filter.value) ? filter.value : []) : [filter.value];
    const allowed = schema?.enum ?? (schema?.const !== undefined ? [schema.const] : undefined);
    for (const [i, v] of values.entries()) {
      const at = filter.operator === "in" ? `${path}/value/${i}` : `${path}/value`;
      if (allowed ? !allowed.includes(v) : !admitted.has(kindOf(v))) {
        const never = `${type.name}.${filter.property} is never ${JSON.stringify(v)}${allowed ? `: it is one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}` : `: it is ${[...admitted].join(" or ")}`}`;
        // "ne" a value the property never has is true of every object: it runs, and filters nothing.
        this.report(
          filter.operator === "ne"
            ? { severity: "warning", code: "always-matches", path: at, message: `${never}, so this condition filters nothing` }
            : { severity: "error", code: "value-never-matches", path: at, message: never }
        );
      }
    }
  }

  relationship(type: TypeDescription, name: string, path: string): TypeDescription | undefined {
    const current = type.aliases?.[name];
    if (current) this.report({ severity: "warning", code: "deprecated-alias", path, message: `"${name}" is an old name for "${current}" (ADR-0010)`, suggestion: current });
    const resolved = current ?? name;
    const rel = type.relationships.find((r) => r.name === resolved);
    if (!rel) {
      const suggestion = didYouMean(name, type.relationships.map((r) => r.name));
      this.report({ severity: "error", code: "unknown-relationship", path, message: `${type.name} has no relationship "${name}"`, ...(suggestion ? { suggestion } : {}) });
      return undefined;
    }
    return this.types.get(rel.target);
  }

  includes(type: TypeDescription, includes: readonly QueryInclude[], path: string): void {
    includes.forEach((inc, i) => {
      const at = `${path}/${i}`;
      const target = this.relationship(type, inc.relationship, `${at}/relationship`);
      if (!target) return;
      inc.select?.forEach((s, j) => this.value(target, s, `${at}/select/${j}`, { allowComputed: true, what: "A projection" }));
      if (inc.filter) this.filter(target, inc.filter, `${at}/filter`);
      // An include sorts after resolution (ADR-0028), so a computed property is allowed here.
      inc.sort?.forEach((s, j) => this.value(target, s.property, `${at}/sort/${j}/property`, { allowComputed: true, what: "A sort" }));
      if (inc.include) this.includes(target, inc.include, `${at}/include`);
    });
  }
}

/** One compiled validator per set of limits: compiling the query schema costs far more than checking a query against it. */
const shapeValidators = new Map<string, InputValidator>();
function shapeValidator(limits: Partial<QueryLimits> = {}): InputValidator {
  const key = JSON.stringify(limits);
  let validator = shapeValidators.get(key);
  if (!validator) shapeValidators.set(key, (validator = new InputValidator(limits)));
  return validator;
}

/**
 * Checks a composed query against the model without running it (ADR-0056):
 * the runtime's own shape and limit checks first, then every Type, value,
 * relationship and operator it names, with the name probably meant. It
 * answers what the model allows, never what a caller may read: that is
 * decided when the query runs.
 */
export function validateQuery(model: ModelDescription, query: unknown, limits?: Partial<QueryLimits>): Diagnostic[] {
  try {
    shapeValidator(limits).validateQuery(query);
  } catch (err) {
    return [{ severity: "error", code: "invalid-query", path: "", message: err instanceof Error ? err.message : String(err) }];
  }
  const q = query as SemanticQuery;
  const check = new QueryChecker(model);
  const type = check.type(q.type, "/type");
  if (!type) return check.diagnostics;
  if (q.filter) check.filter(type, q.filter, "/filter");
  q.select?.forEach((s, i) => check.value(type, s, `/select/${i}`, { allowComputed: true, what: "A projection" }));
  q.sort?.forEach((s, i) => check.value(type, s.property, `/sort/${i}/property`, { allowComputed: false, what: "A top-level sort", why: "the source system sorts, before it is computed (ADR-0054)" }));
  q.search?.properties?.forEach((p, i) => {
    const schema = check.value(type, p, `/search/properties/${i}`, { allowComputed: false, what: "A search", why: "search runs in the source system (ADR-0027)" });
    if (p in type.properties && kinds(schema ?? undefined)?.has("string") === false) {
      check.diagnostics.push({ severity: "error", code: "search-property", path: `/search/properties/${i}`, message: `Search reads string values, and ${type.name}.${p} is not one` });
    }
  });
  if (q.include) check.includes(type, q.include, "/include");
  return check.diagnostics;
}
