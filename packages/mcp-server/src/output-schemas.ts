import type { JsonSchema2020 } from "@typesys/core";

/**
 * The `outputSchema` of each tool that is not an Action (ADR-0051). An MCP
 * client validates a result's `structuredContent` against these, so they
 * say what the runtime returns and nothing stricter: a Type's own schema
 * cannot appear here, since one tool serves every Type, so object `values`
 * are left open.
 *
 * Kept to keywords every JSON Schema draft a client might validate with
 * understands — no `$schema`, `$defs`, or 2020-12-only keywords.
 */

const PROVENANCE_REF: JsonSchema2020 = {
  type: "object",
  required: ["propertyPath", "source", "retrievedAt"],
  properties: {
    propertyPath: { type: "string" },
    source: {
      type: "object",
      required: ["dataSourceId", "system"],
      properties: {
        dataSourceId: { type: "string" },
        system: { type: "string" },
        recordId: { type: "string" },
        field: { type: "string" }
      }
    },
    observedAt: { type: "string" },
    retrievedAt: { type: "string" },
    confidence: { type: "number" },
    classification: { type: "string" }
  }
};

const RESOLVED_OBJECT: JsonSchema2020 = {
  type: "object",
  required: ["typeName", "objectId", "values"],
  properties: {
    typeName: { type: "string" },
    objectId: { type: "string" },
    values: { type: "object", description: "The properties the caller may read; included relationships appear here by name." },
    provenance: { type: "array", items: PROVENANCE_REF }
  }
};

export const QUERY_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["items"],
  properties: {
    items: { type: "array", items: RESOLVED_OBJECT },
    nextCursor: { type: "string", description: "Pass as `cursor` for the next page. A short page with a cursor is normal." }
  }
};

export const AGGREGATE_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        required: ["key", "values"],
        properties: {
          key: { type: "object", description: "One entry per `groupBy` property; empty when not grouping." },
          values: {
            type: "object",
            description: "Each aggregation's value by its name; null where the value is not a finite number, which JSON cannot carry.",
            additionalProperties: { type: ["number", "null"] }
          }
        }
      }
    }
  }
};

export const TYPE_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["name", "version", "schema", "relationships", "actionNames", "computedPropertyNames"],
  properties: {
    name: { type: "string" },
    version: { type: "string" },
    description: { type: "string" },
    schema: { type: "object" },
    relationships: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "targetType", "cardinality"],
        properties: { name: { type: "string" }, targetType: { type: "string" }, cardinality: { type: "string" }, inverseName: { type: "string" } }
      }
    },
    actionNames: { type: "array", items: { type: "string" } },
    computedPropertyNames: { type: "array", items: { type: "string" } }
  }
};

/** `structuredContent` must be an object, so the list of Types is wrapped. */
export const TYPES_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["types"],
  properties: { types: { type: "array", items: TYPE_OUTPUT } }
};

export const OBJECT_OUTPUT: JsonSchema2020 = RESOLVED_OBJECT;

/** Wrapped for the same reason as `TYPES_OUTPUT`. */
export const RELATIONSHIP_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["objects"],
  properties: { objects: { type: "array", items: RESOLVED_OBJECT } }
};

/** Wrapped for the same reason as `TYPES_OUTPUT`. */
export const PROVENANCE_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["provenance"],
  properties: { provenance: { type: "array", items: PROVENANCE_REF } }
};

/** `typesys_list_actions` (ADR-0053): what the caller may invoke, on a Type or on one object of it. */
export const ACTIONS_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "description", "authorized", "instanceScoped", "sideEffects", "idempotency"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          authorized: { type: "boolean", description: "Decided as invoking it would be; for an instance-scoped Action without an id, per Type." },
          instanceScoped: { type: "boolean", description: "Decided per object: pass the object's id to know." },
          sideEffects: { type: "string" },
          idempotency: { type: "string" }
        }
      }
    }
  }
};

/** `typesys_preview_action` (ADR-0053): `SemanticRuntime.previewAction`'s `ActionPreview`. */
export const ACTION_PREVIEW_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["action", "version", "authorized", "inputValid", "preconditions", "blockers", "wouldExecute", "effects"],
  properties: {
    action: { type: "string" },
    version: { type: "string" },
    target: { type: "object", required: ["typeName", "objectId"], properties: { typeName: { type: "string" }, objectId: { type: "string" } } },
    authorized: { type: "boolean" },
    inputValid: { type: ["boolean", "null"] },
    preconditions: {
      type: "array",
      items: { type: "object", required: ["description", "satisfied"], properties: { description: { type: "string" }, satisfied: { type: ["boolean", "null"] } } }
    },
    blockers: {
      type: "array",
      items: { type: "object", required: ["kind", "message"], properties: { kind: { type: "string" }, message: { type: "string" } } }
    },
    wouldExecute: { type: "boolean" },
    effects: {
      type: "object",
      required: ["sideEffects", "idempotency", "auditRequired"],
      properties: { sideEffects: { type: "string" }, idempotency: { type: "string" }, auditRequired: { type: "boolean" } }
    }
  }
};

/** `typesys_explain_query` (ADR-0054): how a query would run, without the authorization plan ADR-0038 keeps runtime-only. */
export const EXPLAIN_OUTPUT: JsonSchema2020 = {
  type: "object",
  required: ["steps", "adapterCallsPerObject", "notes"],
  properties: {
    steps: { type: "array", items: { type: "object", required: ["op"], properties: { op: { type: "string" } } } },
    adapterCallsPerObject: { type: "object", properties: { overrides: { type: "number" }, computed: { type: "number" } } },
    notes: { type: "array", items: { type: "string" } }
  }
};
