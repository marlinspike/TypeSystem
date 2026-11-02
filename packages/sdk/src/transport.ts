import type {
  ActionPreview,
  ActionSummary,
  AggregateResult,
  ConsumerContract,
  ExecutionPlan,
  Identity,
  ProvenanceRef,
  QueryResult,
  ResolvedObject,
  SemanticAggregateQuery,
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
  /** Grouped counts and sums (ADR-0027). Optional, so a transport written before it still compiles; each one shipped here has it. */
  aggregate?(query: SemanticAggregateQuery): Promise<AggregateResult>;
}

type InProcessRuntime = Pick<
  SemanticRuntime,
  "query" | "explainQuery" | "getObject" | "getRelationship" | "getProvenance" | "listActions" | "previewAction" | "invokeAction" | "aggregate"
>;

/**
 * The `TypeSystem-Contract` header's value for a consumer's contract
 * (ADR-0103): comma-separated `Type@range`. Send it with every request, as
 * `httpTransport`'s `contract` option does; for an MCP client, set it among
 * the Streamable HTTP transport's request headers.
 */
export function contractHeader(contract: ConsumerContract): string {
  return Object.entries(contract)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, range]) => `${type}@${range}`)
    .join(", ");
}

/**
 * Calls a runtime in this process as one caller. Errors are the runtime's own (`AuthorizationError`, `InvalidInputError`, ...).
 * With `contract`, every call is made under the consumer's contract (ADR-0103).
 */
export function runtimeTransport(runtime: InProcessRuntime, identity: Identity, opts: { readonly contract?: ConsumerContract } = {}): Transport {
  // Loaded on use: everything else this package takes from core is a type, which keeps it loadable in a
  // browser, where a client reaches the runtime over a wire and core's Node-only runtime never loads.
  const core = () => import("@typesys/core");
  const run = async <T>(fn: () => Promise<T>): Promise<T> => (opts.contract ? (await core()).runUnderContract(opts.contract, fn) : fn());
  return {
    query: (q) => run(() => runtime.query(q, identity)),
    explain: (q) => run(async () => (await runtime.explainQuery(q, identity)).execution),
    getObject: (type, id, o) => run(() => runtime.getObject(type, id, identity, o)),
    getRelationship: (type, id, rel) => run(() => runtime.getRelationship(type, id, rel, identity)),
    getProvenance: (type, id, property) => run(() => runtime.getProvenance(type, id, property, identity)),
    listActions: (type, id) =>
      run(async () => {
        const { summarizeAction } = await core();
        return (await runtime.listActions(type, identity, id === undefined ? {} : { objectId: id })).map(summarizeAction);
      }),
    previewAction: (action, input) => run(() => runtime.previewAction(action, input, identity)),
    invokeAction: (action, input) => run(() => runtime.invokeAction(action, input, identity)),
    aggregate: (q) => run(() => runtime.aggregate(q, identity))
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
 * Calls a TypeSys MCP server's `typesys_*` tools and its Action tools (ADR-0012,
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
    invokeAction: (action, input) => call(action, { ...(input as Record<string, unknown>) }),
    aggregate: async (q) => (await call("typesys_aggregate", { ...q })) as AggregateResult
  };
}

/**
 * A refusal or failure from a TypeSys REST API (ADR-0058): its HTTP status, the
 * problem's stable `code` (`forbidden`, `not-found`, `invalid-input`,
 * `precondition-failed`, `rate-limited`, `contract-unsatisfied`, ...) to branch on, and for a
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
  /**
   * The Types and versions this client was built against (ADR-0103), sent
   * with every request. The API refuses, with `contract-unsatisfied` (412),
   * any call that touches a Type outside them, rather than answer in a shape
   * the client does not expect.
   */
  readonly contract?: ConsumerContract;
}

/**
 * One call to a TypeSys REST API (`@typesys/http`, ADR-0058) with the bearer
 * token attached: the JSON answer, or an `ApiError` carrying the problem's
 * `code` and `reason`. For the routes a `Transport` does not cover, such as
 * `/model`, `/query/validate` and `/discover`.
 */
export type HttpCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;

export function httpCall(opts: HttpTransportOptions): HttpCall {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const contract: Record<string, string> = opts.contract && Object.keys(opts.contract).length > 0 ? { "typesystem-contract": contractHeader(opts.contract) } : {};
  return async (method, path, body) => {
    const token = typeof opts.token === "function" ? await opts.token() : opts.token;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...contract },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    if (!res.ok) {
      // An error body need not be JSON: a proxy's 502 page, or anything else in front of the API.
      let p: { code?: string; detail?: string; reason?: string } = {};
      try {
        p = ((text === "" ? undefined : JSON.parse(text)) ?? {}) as typeof p;
      } catch {
        // Not a problem document; the status alone says what happened.
      }
      throw new ApiError(res.status, p.code ?? "internal", p.detail ?? `HTTP ${res.status}`, p.reason);
    }
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  };
}

/**
 * Calls a TypeSys REST API (`@typesys/http`, ADR-0058). It needs only `fetch`,
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
    invokeAction: async (action, input) => ((await call("POST", `/actions/${seg(action)}/invoke`, input)) as { result: unknown }).result,
    aggregate: async (q) => (await call("POST", "/aggregate", q)) as AggregateResult
  };
}
