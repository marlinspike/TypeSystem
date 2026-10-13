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
