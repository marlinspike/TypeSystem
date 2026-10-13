import { aggregateQuerySchema, semanticQuerySchema, type JsonSchema2020, type ModelDescription } from "@typesys/core";

type Json = Record<string, unknown>;

/** Moves a schema's `$defs` into components under `<name>__<def>`, rewriting every `#/$defs/` reference to match. */
function component(name: string, schema: JsonSchema2020, into: Record<string, unknown>): Json {
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => k !== "$defs")
        .map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/$defs/") ? `#/components/schemas/${name}__${v.slice(8)}` : rewrite(v)])
    );
  };
  for (const [def, s] of Object.entries((schema as { $defs?: Record<string, unknown> }).$defs ?? {})) into[`${name}__${def}`] = rewrite(s);
  into[name] = rewrite(schema);
  return { $ref: `#/components/schemas/${name}` };
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown): Json => ({ content: { "application/json": { schema } } });
const problem: Json = { description: "Refused or failed, as an RFC 9457 problem", content: { "application/problem+json": { schema: ref("Problem") } } };
const op = (operationId: string, summary: string, ok: unknown, extra: Json = {}): Json => ({
  operationId,
  summary,
  ...extra,
  responses: { "200": { description: "OK", ...json(ok) }, default: problem }
});
const pathParam = (name: string): Json => ({ name, in: "path", required: true, schema: { type: "string" } });
const safe = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * The API as OpenAPI 3.1 (ADR-0058), generated from the model description:
 * one path per Type's objects and per Action, each typed by the model's own
 * schemas, so a generated client or a tool-calling agent gets the same
 * contract the runtime enforces. Every value of an object is optional, since
 * policy may withhold any of them (ADR-0055).
 */
export function openApiDocument(model: ModelDescription, opts: { title?: string; version?: string; workflows?: boolean } = {}): Json {
  const schemas: Record<string, unknown> = {
    Problem: {
      type: "object",
      properties: {
        type: { type: "string" },
        title: { type: "string" },
        status: { type: "integer" },
        code: { enum: ["forbidden", "not-found", "invalid-input", "precondition-failed", "rate-limited", "conflict", "workflow-diverged", "unavailable", "internal"] },
        detail: { type: "string" },
        reason: { type: "string" },
        errors: {}
      },
      required: ["type", "title", "status", "code", "detail"]
    },
    Provenance: { type: "object", additionalProperties: true },
    ResolvedObject: {
      type: "object",
      properties: { typeName: { type: "string" }, objectId: { type: "string" }, values: { type: "object" }, provenance: { type: "array", items: ref("Provenance") } },
      required: ["typeName", "objectId", "values"]
    },
    ModelDescription: { type: "object", properties: { format: { const: "typesys.model/1" } }, required: ["format"] },
    ActionSummary: { type: "object", additionalProperties: true },
    ActionPreview: { type: "object", additionalProperties: true }
  };
  const query = component("SemanticQuery", semanticQuerySchema(), schemas);
  const aggregate = component("AggregateQuery", aggregateQuerySchema(), schemas);
  const page = (items: unknown) => ({ type: "object", properties: { items: { type: "array", items }, nextCursor: { type: "string" } }, required: ["items"] });

  const paths: Record<string, Json> = {
    "/model": { get: op("describeModel", "The model: every Type and Action, composed", ref("ModelDescription")) },
    "/query": { post: op("query", "Objects of one Type, as this caller may read them", page(ref("ResolvedObject")), { requestBody: { required: true, ...json(query) } }) },
    "/query/explain": { post: op("explainQuery", "How a query would run, without running it", { type: "object" }, { requestBody: { required: true, ...json(query) } }) },
    "/query/validate": {
      post: op("validateQuery", "Every problem with a query, checked against the model", { type: "object" }, {
        requestBody: { required: true, ...json({ type: "object", properties: { query: query }, required: ["query"] }) }
      })
    },
    "/aggregate": { post: op("aggregate", "Grouped counts and sums", { type: "object" }, { requestBody: { required: true, ...json(aggregate) } }) },
    "/discover": {
      post: op("discover", "The Types and Actions that fit a task, ranked", { type: "array" }, {
        requestBody: { required: true, ...json({ type: "object", properties: { task: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["task"] }) }
      })
    },
    "/objects/{type}/{id}/related/{relationship}": {
      get: op("getRelated", "The objects one object relates to", { type: "array", items: ref("ResolvedObject") }, { parameters: ["type", "id", "relationship"].map(pathParam) })
    },
    "/objects/{type}/{id}/provenance/{property}": {
      get: op("getProvenance", "Where one value came from", { type: "array", items: ref("Provenance") }, { parameters: ["type", "id", "property"].map(pathParam) })
    },
    "/types/{type}/actions": {
      get: op("listActions", "The Actions on a Type or one object, and whether this caller may invoke each", { type: "array", items: ref("ActionSummary") }, {
        parameters: [pathParam("type"), { name: "objectId", in: "query", required: false, schema: { type: "string" } }]
      })
    }
  };

  for (const type of model.types) {
    const values: Record<string, unknown> = { ...type.properties };
    for (const c of type.computed) values[c.name] = c.schema ?? {};
    schemas[type.name] = { type: "object", description: "Every value optional: policy may withhold any of them.", properties: values };
    schemas[`${type.name}.Object`] = {
      type: "object",
      properties: { typeName: { const: type.name }, objectId: { type: "string" }, values: ref(type.name), provenance: { type: "array", items: ref("Provenance") } },
      required: ["typeName", "objectId", "values"]
    };
    paths[`/objects/${type.name}/{id}`] = {
      get: op(`get_${safe(type.name)}`, `One ${type.name}`, ref(`${type.name}.Object`), {
        parameters: [pathParam("id"), { name: "provenance", in: "query", required: false, schema: { enum: ["true", "false"] } }]
      })
    };
  }

  for (const action of model.actions) {
    const input = component(`${action.name}.Input`, action.inputSchema, schemas);
    const output = component(`${action.name}.Output`, action.outputSchema, schemas);
    const request = { requestBody: { required: true, ...json(input) } };
    paths[`/actions/${action.name}/preview`] = { post: op(`preview_${safe(action.name)}`, `What ${action.name} would do, with nothing executed`, ref("ActionPreview"), request) };
    paths[`/actions/${action.name}/invoke`] = {
      post: op(`invoke_${safe(action.name)}`, action.description, { type: "object", properties: { result: output }, required: ["result"] }, {
        ...request,
        "x-typesys-side-effects": action.sideEffects,
        "x-typesys-idempotency": action.idempotency
      })
    };
  }

  if (opts.workflows) {
    const run = { type: "object", additionalProperties: true };
    paths["/workflows/{name}/runs"] = {
      post: {
        operationId: "startWorkflow",
        summary: "Start a run as this caller",
        parameters: [pathParam("name")],
        requestBody: { required: true, ...json({ type: "object", properties: { input: {} }, required: ["input"] }) },
        responses: { "201": { description: "Started", ...json(run) }, default: problem }
      }
    };
    paths["/workflow-runs/{id}"] = { get: op("workflowStatus", "Where a run is, with no values", run, { parameters: [pathParam("id")] }) };
    paths["/workflow-runs/{id}/outputs"] = { get: op("workflowOutputs", "A run's outputs, to its initiator only", { type: "object" }, { parameters: [pathParam("id")] }) };
    paths["/workflow-runs/{id}/approval"] = { get: op("pendingApproval", "What the waiting approval presents, to an admitted approver", { type: "object" }, { parameters: [pathParam("id")] }) };
    paths["/workflow-runs/{id}/approvals/{step}"] = {
      post: op("decideApproval", "Approve or reject, as an admitted approver other than the initiator", run, {
        parameters: [pathParam("id"), pathParam("step")],
        requestBody: { required: true, ...json({ type: "object", properties: { approved: { type: "boolean" }, comment: { type: "string" } }, required: ["approved"] }) }
      })
    };
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: opts.title ?? "TypeS API", version: opts.version ?? "0.1.0" },
    servers: [{ url: "/api" }],
    security: [{ bearer: [] }],
    paths,
    components: { schemas, securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }
  };
}
