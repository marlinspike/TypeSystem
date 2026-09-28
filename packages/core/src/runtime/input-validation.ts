import type { ErrorObject, ValidateFunction } from "ajv";
import { createSemanticValidator } from "../registry/validation.js";
import type { JsonSchema2020 } from "../model/json-schema.js";
import type { ActionDefinition } from "../model/action.js";
import type { QueryFilter, QueryInclude, SemanticQuery } from "../model/query.js";
import { InvalidInputError } from "./errors.js";

/**
 * Bounds on what a single `query` call may ask for. The query DSL is
 * external input (an MCP tool, an HTTP body), so without these one caller
 * could request an unbounded page, an arbitrarily deep filter tree, or a
 * fan-out of includes per item — each multiplying adapter work.
 */
export interface QueryLimits {
  /** Page size applied when a query omits `limit` — adapters return *everything* for an absent limit. */
  defaultLimit: number;
  /** Largest `limit` a caller may request. Larger values are rejected, not clamped, so callers learn the bound. */
  maxLimit: number;
  /** Most `include` entries across the whole include tree, every level counted (each is one relationship resolution per object it applies to). */
  maxIncludes: number;
  /** Deepest `include` nesting (a top-level include is depth 1). Each level multiplies the objects resolved. */
  maxIncludeDepth: number;
  /** Deepest `and`/`or` nesting allowed in any one filter, top-level or include-level (a bare condition is depth 1). */
  maxFilterDepth: number;
  /** Most leaf conditions allowed in any one filter, top-level or include-level. */
  maxFilterConditions: number;
}

export const DEFAULT_QUERY_LIMITS: QueryLimits = {
  defaultLimit: 100,
  maxLimit: 1000,
  maxIncludes: 10,
  maxIncludeDepth: 3,
  maxFilterDepth: 8,
  maxFilterConditions: 100
};

/**
 * Hard cap on raw JSON nesting for any validated input, checked before Ajv
 * runs: Ajv validates recursive `$ref`s recursively, so a hostile payload
 * nested thousands of levels deep would overflow the stack before any
 * schema-level bound (like `maxFilterDepth`) got a chance to reject it.
 */
const MAX_JSON_DEPTH = 64;

const NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_.-]*$";

/**
 * The JSON Schema for a `SemanticQuery` (see `model/query.ts`). Also the
 * MCP `query` tool's advertised inputSchema, so what an agent is told and
 * what the runtime enforces are the same document.
 */
export function semanticQuerySchema(limits: QueryLimits = DEFAULT_QUERY_LIMITS): JsonSchema2020 {
  return {
    type: "object",
    properties: {
      type: { type: "string", pattern: NAME_PATTERN, maxLength: 256, description: "Logical type name to query, e.g. airforce.Aircraft" },
      filter: { $ref: "#/$defs/filter" },
      include: {
        type: "array",
        maxItems: limits.maxIncludes,
        items: { $ref: "#/$defs/include" },
        description: "Relationships to navigate and include inline"
      },
      includeProvenance: { type: "boolean" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: limits.maxLimit,
        description: `Page size (default ${limits.defaultLimit}, max ${limits.maxLimit})`
      },
      cursor: { type: "string", maxLength: 1024, description: "Opaque cursor from a previous page's nextCursor" }
    },
    required: ["type"],
    additionalProperties: false,
    $defs: {
      filter: {
        description: "A QueryFilter: {property, operator, value} or {and:[...]}/{or:[...]}",
        oneOf: [
          {
            type: "object",
            properties: {
              property: { type: "string", pattern: NAME_PATTERN, maxLength: 256 },
              operator: { enum: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] },
              value: {}
            },
            required: ["property", "operator", "value"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: { and: { type: "array", minItems: 1, items: { $ref: "#/$defs/filter" } } },
            required: ["and"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: { or: { type: "array", minItems: 1, items: { $ref: "#/$defs/filter" } } },
            required: ["or"],
            additionalProperties: false
          }
        ]
      },
      include: {
        type: "object",
        properties: {
          relationship: { type: "string", pattern: NAME_PATTERN, maxLength: 256 },
          filter: { $ref: "#/$defs/filter" },
          include: { type: "array", maxItems: limits.maxIncludes, items: { $ref: "#/$defs/include" } }
        },
        required: ["relationship"],
        additionalProperties: false
      }
    }
  };
}

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("; ");
}

function assertJsonDepth(input: unknown, what: string): void {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (depth > MAX_JSON_DEPTH) throw new InvalidInputError(`Invalid ${what}: nested more than ${MAX_JSON_DEPTH} levels deep`);
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
}

/** Depth and leaf count are not expressible in JSON Schema, so they're walked here — iteratively, so a hostile nesting can't blow the stack. */
function measureFilter(filter: QueryFilter): { depth: number; conditions: number } {
  let depth = 0;
  let conditions = 0;
  const stack: { node: QueryFilter; level: number }[] = [{ node: filter, level: 1 }];
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    depth = Math.max(depth, level);
    const children = "and" in node ? node.and : "or" in node ? node.or : undefined;
    if (children) for (const child of children) stack.push({ node: child, level: level + 1 });
    else conditions++;
  }
  return { depth, conditions };
}

/**
 * Validates caller-supplied input at the runtime boundary — the query DSL
 * against its schema and `QueryLimits`, and Action input against each
 * Action's own `inputSchema`. Lives in the runtime (not a transport) so an
 * application, the demo HTTP API, and an MCP agent all get identical
 * checks, the same way they get identical policy (ADR-0009/0012).
 */
export class InputValidator {
  readonly limits: QueryLimits;
  private readonly ajv = createSemanticValidator();
  private readonly validateQueryShape: ValidateFunction;
  /** Keyed by name@version, not object identity: a durable RegistryStore hands back a fresh ActionDefinition per read. */
  private readonly actionValidators = new Map<string, ValidateFunction>();

  constructor(limits: Partial<QueryLimits> = {}) {
    this.limits = { ...DEFAULT_QUERY_LIMITS, ...limits };
    if (this.limits.defaultLimit > this.limits.maxLimit) {
      throw new Error(`QueryLimits.defaultLimit (${this.limits.defaultLimit}) exceeds maxLimit (${this.limits.maxLimit})`);
    }
    this.validateQueryShape = this.ajv.compile(semanticQuerySchema(this.limits));
  }

  /** Throws `InvalidInputError` on a malformed or over-limit query; otherwise returns it with `limit` defaulted. */
  validateQuery(input: unknown): SemanticQuery & { limit: number } {
    assertJsonDepth(input, "query");
    if (!this.validateQueryShape(input)) {
      throw new InvalidInputError(`Invalid query: ${describeErrors(this.validateQueryShape.errors)}`, this.validateQueryShape.errors);
    }
    const query = input as SemanticQuery;
    if (query.filter) this.checkFilter(query.filter, "filter");
    if (query.include) this.checkIncludeTree(query.include);
    return { ...query, limit: query.limit ?? this.limits.defaultLimit };
  }

  private checkFilter(filter: QueryFilter, where: string): void {
    const { depth, conditions } = measureFilter(filter);
    if (depth > this.limits.maxFilterDepth) {
      throw new InvalidInputError(`Invalid query: ${where} nesting depth ${depth} exceeds the maximum of ${this.limits.maxFilterDepth}`);
    }
    if (conditions > this.limits.maxFilterConditions) {
      throw new InvalidInputError(
        `Invalid query: ${where} has ${conditions} conditions, exceeding the maximum of ${this.limits.maxFilterConditions}`
      );
    }
  }

  /** Walks the include tree iteratively: total entries, depth, duplicate siblings, and each include-level filter. */
  private checkIncludeTree(includes: QueryInclude[]): void {
    let total = 0;
    const stack: { siblings: QueryInclude[]; depth: number; path: string }[] = [{ siblings: includes, depth: 1, path: "include" }];
    while (stack.length > 0) {
      const { siblings, depth, path } = stack.pop()!;
      if (depth > this.limits.maxIncludeDepth) {
        throw new InvalidInputError(`Invalid query: include nesting depth ${depth} exceeds the maximum of ${this.limits.maxIncludeDepth}`);
      }
      total += siblings.length;
      if (total > this.limits.maxIncludes) {
        throw new InvalidInputError(`Invalid query: more than ${this.limits.maxIncludes} include entries across all levels`);
      }
      const seen = new Set<string>();
      for (const inc of siblings) {
        // Results are keyed by relationship name, so a second entry would silently overwrite the first.
        if (seen.has(inc.relationship)) {
          throw new InvalidInputError(`Invalid query: relationship "${inc.relationship}" is included twice at ${path}`);
        }
        seen.add(inc.relationship);
        const incPath = `${path}.${inc.relationship}`;
        if (inc.filter) this.checkFilter(inc.filter, `${incPath} filter`);
        if (inc.include) stack.push({ siblings: inc.include, depth: depth + 1, path: incPath });
      }
    }
  }

  /** Throws `InvalidInputError` when `input` doesn't satisfy the Action's declared `inputSchema`. */
  validateActionInput(action: ActionDefinition, input: unknown): void {
    const key = `${action.name}@${action.version}`;
    let validate = this.actionValidators.get(key);
    if (!validate) {
      // Strip any $id so re-registering a changed schema under a new version can't collide in Ajv's schema map.
      const { $id: _ignored, ...schema } = action.inputSchema;
      validate = this.ajv.compile(schema);
      this.actionValidators.set(key, validate);
    }
    assertJsonDepth(input, `input for action "${action.name}"`);
    if (!validate(input)) {
      throw new InvalidInputError(`Invalid input for action "${action.name}": ${describeErrors(validate.errors)}`, validate.errors);
    }
  }
}
