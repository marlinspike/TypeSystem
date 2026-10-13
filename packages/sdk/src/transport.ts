import type {
  ActionPreview,
  ActionSummary,
  ExecutionPlan,
  Identity,
  ProvenanceRef,
  QueryResult,
  ResolvedObject,
  SemanticQuery,
  SemanticRuntime
} from "@typesys/core";

/**
 * Where a client's calls go (ADR-0055). Every method is one runtime operation
 * with its wire shapes, so a transport adds no semantics and enforces nothing:
 * policy, classification, limits, and audit are the runtime's, wherever it
 * runs. The SDK's types sit above this seam; nothing below it is typed by the
 * model.
 */
export interface Transport {
  query(query: SemanticQuery): Promise<QueryResult<ResolvedObject>>;
  explain(query: SemanticQuery): Promise<ExecutionPlan>;
  getObject(type: string, id: string, opts: { includeProvenance: boolean }): Promise<ResolvedObject>;
  getRelationship(type: string, id: string, relationship: string): Promise<ResolvedObject[]>;
  getProvenance(type: string, id: string, property: string): Promise<ProvenanceRef[]>;
  listActions(type: string, id?: string): Promise<ActionSummary[]>;
  previewAction(action: string, input: unknown): Promise<ActionPreview>;
  invokeAction(action: string, input: unknown): Promise<unknown>;
}

type InProcessRuntime = Pick<
  SemanticRuntime,
  "query" | "explainQuery" | "getObject" | "getRelationship" | "getProvenance" | "listActions" | "previewAction" | "invokeAction"
>;

/** Calls a runtime in this process as one caller. Errors are the runtime's own (`AuthorizationError`, `InvalidInputError`, ...). */
export function runtimeTransport(runtime: InProcessRuntime, identity: Identity): Transport {
  return {
    query: (q) => runtime.query(q, identity),
    explain: async (q) => (await runtime.explainQuery(q, identity)).execution,
    getObject: (type, id, opts) => runtime.getObject(type, id, identity, opts),
    getRelationship: (type, id, rel) => runtime.getRelationship(type, id, rel, identity),
    getProvenance: (type, id, property) => runtime.getProvenance(type, id, property, identity),
    listActions: async (type, id) => {
      // Loaded on use: everything else this package takes from core is a type, which keeps it loadable in a
      // browser, where a client reaches the runtime over a wire and core's Node-only runtime never loads.
      const { summarizeAction } = await import("@typesys/core");
      return (await runtime.listActions(type, identity, id === undefined ? {} : { objectId: id })).map(summarizeAction);
    },
    previewAction: (action, input) => runtime.previewAction(action, input, identity),
    invokeAction: (action, input) => runtime.invokeAction(action, input, identity)
  };
}

/** What `mcpTransport` needs of an MCP client: `Client.callTool` from `@modelcontextprotocol/sdk`, or anything shaped like it. */
export interface ToolCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/** A tool call that came back as an MCP tool error. `message` is the server's text, which is all MCP carries. */
export class RemoteToolError extends Error {
  constructor(
    readonly tool: string,
    message: string
  ) {
    super(message);
    this.name = "RemoteToolError";
  }
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

/**
 * Calls a TypeS MCP server's `typesys_*` tools and its Action tools (ADR-0012,
 * ADR-0051). `authToken` travels in each call's arguments, as the server's
 * tools take it.
 */
export function mcpTransport(client: ToolCaller, opts: { authToken?: string } = {}): Transport {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await client.callTool({ name, arguments: { ...args, ...(opts.authToken === undefined ? {} : { authToken: opts.authToken }) } })) as ToolResult;
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) throw new RemoteToolError(name, text);
    return result.structuredContent ?? (text === "" ? undefined : JSON.parse(text));
  };
  return {
    query: async (q) => (await call("typesys_query", { ...q })) as QueryResult<ResolvedObject>,
    explain: async (q) => (await call("typesys_explain_query", { ...q })) as ExecutionPlan,
    getObject: async (type, id, { includeProvenance }) => {
      // The MCP read always carries provenance; drop it when the caller did not ask, so both transports answer alike.
      const { provenance, ...object } = (await call("typesys_get_object", { type, id })) as ResolvedObject;
      return includeProvenance ? { ...object, provenance: provenance ?? [] } : object;
    },
    getRelationship: async (type, id, relationship) => ((await call("typesys_get_relationship", { type, id, relationship })) as { objects: ResolvedObject[] }).objects,
    getProvenance: async (type, id, property) => ((await call("typesys_get_provenance", { type, id, property })) as { provenance: ProvenanceRef[] }).provenance,
    listActions: async (type, id) => ((await call("typesys_list_actions", id === undefined ? { type } : { type, id })) as { actions: ActionSummary[] }).actions,
    previewAction: async (action, input) => (await call("typesys_preview_action", { action, input })) as ActionPreview,
    invokeAction: (action, input) => call(action, { ...(input as Record<string, unknown>) })
  };
}

/**
 * A refusal or failure from a TypeS REST API (ADR-0058): its HTTP status, the
 * problem's stable `code` (`forbidden`, `not-found`, `invalid-input`,
 * `precondition-failed`, `rate-limited`, ...) to branch on, and for a
 * refusal the policy's `reason`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HttpTransportOptions {
  /** Where the API is mounted, e.g. `https://typesys.example.mil/api`. */
  readonly baseUrl: string;
  /** The caller's bearer token, or a function that returns the current one (a refreshed session token). */
  readonly token?: string | (() => string | undefined | Promise<string | undefined>);
  /** Default: the global `fetch` (browsers, Node 18 and later). */
  readonly fetch?: typeof fetch;
}

/**
 * One call to a TypeS REST API (`@typesys/http`, ADR-0058) with the bearer
 * token attached: the JSON answer, or an `ApiError` carrying the problem's
 * `code` and `reason`. For the routes a `Transport` does not cover, such as
 * `/model`, `/query/validate` and `/discover`.
 */
export type HttpCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;

export function httpCall(opts: HttpTransportOptions): HttpCall {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  return async (method, path, body) => {
    const token = typeof opts.token === "function" ? await opts.token() : opts.token;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    const parsed: unknown = text === "" ? undefined : JSON.parse(text);
    if (!res.ok) {
      const p = (parsed ?? {}) as { code?: string; detail?: string; reason?: string };
      throw new ApiError(res.status, p.code ?? "internal", p.detail ?? `HTTP ${res.status}`, p.reason);
    }
    return parsed;
  };
}

/**
 * Calls a TypeS REST API (`@typesys/http`, ADR-0058). It needs only `fetch`,
 * so the same typed client runs in a browser; every call is decided by the
 * runtime behind the API for the token's identity.
 */
export function httpTransport(opts: HttpTransportOptions): Transport {
  const call = httpCall(opts);
  const seg = encodeURIComponent;
  return {
    query: async (q) => (await call("POST", "/query", q)) as QueryResult<ResolvedObject>,
    explain: async (q) => (await call("POST", "/query/explain", q)) as ExecutionPlan,
    getObject: async (type, id, { includeProvenance }) =>
      (await call("GET", `/objects/${seg(type)}/${seg(id)}${includeProvenance ? "?provenance=true" : ""}`)) as ResolvedObject,
    getRelationship: async (type, id, relationship) => (await call("GET", `/objects/${seg(type)}/${seg(id)}/related/${seg(relationship)}`)) as ResolvedObject[],
    getProvenance: async (type, id, property) => (await call("GET", `/objects/${seg(type)}/${seg(id)}/provenance/${seg(property)}`)) as ProvenanceRef[],
    listActions: async (type, id) => (await call("GET", `/types/${seg(type)}/actions${id === undefined ? "" : `?objectId=${seg(id)}`}`)) as ActionSummary[],
    previewAction: async (action, input) => (await call("POST", `/actions/${seg(action)}/preview`, input)) as ActionPreview,
    invokeAction: async (action, input) => ((await call("POST", `/actions/${seg(action)}/invoke`, input)) as { result: unknown }).result
  };
}
