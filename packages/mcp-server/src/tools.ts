import { ListToolsRequestSchema, CallToolRequestSchema, type Tool, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  AuthorizationError,
  NotFoundError,
  semanticQuerySchema,
  aggregateQuerySchema,
  withSpan,
  summarizeAction,
  type ActionDefinition,
  type Identity,
  type ExplainQuestion,
  type JsonSchema2020,
  type SemanticQuery,
  type SemanticAggregateQuery,
  type SemanticRegistry,
  type SemanticRuntime
} from "@typesys/core";
import type { IdentityResolver } from "./auth.js";
import { readObject, readProvenance, readRelationship, readType, readTypes } from "./reads.js";
import { GRAPH_VIEWS, compileContext, discover, governedGraph, queryGraph, validateQuery, type GraphViewName } from "@typesys/devkit";
import type { McpBackend } from "./backend.js";
import { ACTION_PREVIEW_OUTPUT, ACTIONS_OUTPUT, AGGREGATE_OUTPUT, CONTEXT_OUTPUT, DISCOVER_OUTPUT, EXPLAIN_OUTPUT, VALIDATE_QUERY_OUTPUT, OBJECT_OUTPUT, PROVENANCE_OUTPUT, QUERY_OUTPUT, RELATIONSHIP_OUTPUT, TYPE_OUTPUT, TYPES_OUTPUT } from "./output-schemas.js";

const AUTH_TOKEN_FIELD = {
  authToken: { type: "string", description: "Bearer token identifying the caller (see ADR-0009/0012)." }
};

function withAuthToken(schema: JsonSchema2020): JsonSchema2020 {
  return {
    ...schema,
    type: "object",
    properties: { ...(schema.properties ?? {}), ...AUTH_TOKEN_FIELD }
  };
}

/**
 * Every tool TypeSys itself provides is named with this prefix, and no Action
 * may be (ADR-0051), so a domain's Actions can never shadow a read. An
 * underscore, not a dot: the Claude and OpenAI tool-calling APIs accept only
 * `[A-Za-z0-9_-]` in a tool name, and many agent frameworks pass MCP tool
 * names straight through to them.
 */
export const RESERVED_TOOL_PREFIX = "typesys_";

/** The names `query` and `aggregate` had before ADR-0051. Accepted on call, never listed; removed in the next minor version. */
const DEPRECATED_ALIASES: Readonly<Record<string, string>> = {
  query: `${RESERVED_TOOL_PREFIX}query`,
  aggregate: `${RESERVED_TOOL_PREFIX}aggregate`
};

/** What every built-in tool tells a client: it reads, the same call twice changes nothing, and it reaches only the registry's systems. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * An Action's annotations, from what its definition already declares
 * (ADR-0051). All four are set, since MCP's defaults (destructive, not
 * idempotent, open world) would otherwise speak for the Action. An
 * `external` side effect is reported as possibly destructive: TypeSys cannot
 * see what the external system does with it. Hints only — the runtime
 * enforces policy whatever a client makes of them.
 */
export function actionAnnotations(action: Pick<ActionDefinition, "sideEffects" | "idempotency">): ToolAnnotations {
  return {
    readOnlyHint: action.sideEffects === "none",
    destructiveHint: action.sideEffects === "mutates" || action.sideEffects === "external",
    idempotentHint: action.idempotency !== "none",
    openWorldHint: action.sideEffects === "external"
  };
}

type Args = Record<string, unknown>;

/** The read tools take ids and names, never shapes, so their arguments are checked here rather than by the runtime. */
function strings<const K extends string>(tool: string, args: Args, keys: readonly K[]): Record<K, string> {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "string" || value === "") throw new Error(`${tool}: "${key}" must be a non-empty string`);
  }
  return args as Record<K, string>;
}

function stringArgs(keys: Record<string, string>): JsonSchema2020 {
  return {
    type: "object",
    required: Object.keys(keys),
    properties: Object.fromEntries(Object.entries(keys).map(([key, description]) => [key, { type: "string", description }]))
  };
}

interface BuiltInTool {
  description: string;
  inputSchema: JsonSchema2020;
  outputSchema: JsonSchema2020;
  /** Default: read-only. */
  annotations?: ToolAnnotations;
  /** Returns the tool's `structuredContent`, which is also its text. */
  run(args: Args, identity: Identity): Promise<Record<string, unknown>>;
}

const OPEN_OBJECT: JsonSchema2020 = { type: "object", additionalProperties: true };

function builtInTools(registry: SemanticRegistry, runtime: SemanticRuntime, extras: Pick<McpBackend, "consumers" | "subjects"> = {}): Record<string, BuiltInTool> {
  const p = RESERVED_TOOL_PREFIX;
  /** Another subject, for an inspector only: anyone else is refused before the directory is asked, so they learn nothing of who exists. */
  const subject = async (tool: string, as: unknown, identity: Identity): Promise<Identity | undefined> => {
    if (as === undefined) return undefined;
    if (typeof as !== "string" || as === "") throw new Error(`${tool}: "as" must be a subject id`);
    if (!(await runtime.canInspect(identity))) throw new AuthorizationError("Explaining another subject's access needs the inspection policy");
    if (!extras.subjects) throw new NotFoundError("This server has no subject directory, so only your own access can be explained");
    const found = await extras.subjects.resolve(as);
    if (!found) throw new NotFoundError(`No subject "${as}"`);
    return found;
  };
  return {
    [`${p}list_types`]: {
      description: "List every registered semantic Type, with its schema, relationships, Actions, and computed properties.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: TYPES_OUTPUT,
      run: async (_args, identity) => ({ types: await readTypes(registry, runtime, identity) })
    },
    [`${p}discover`]: {
      description:
        "Start here. The Types and Actions most relevant to a task in plain words, each in a few lines: values with their types, relationships, and the Actions on it. Cheaper than typesys_list_types; then describe_type for one in full.",
      inputSchema: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", description: "What you want to do, in your own words, e.g. \"orders waiting for approval\"." },
          limit: { type: "integer", minimum: 1, maximum: 20, description: "At most this many matches (default 5)." }
        }
      },
      outputSchema: DISCOVER_OUTPUT,
      run: async (args, identity) => {
        const { task } = strings(`${p}discover`, args, ["task"]);
        const limit = args.limit === undefined ? 5 : args.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error(`${p}discover: "limit" must be an integer from 1 to 20`);
        return { matches: discover(await runtime.describeModel(identity), task, { limit }) };
      }
    },
    [`${p}compile_context`]: {
      description:
        "Before writing code against this model: the part of it a coding task needs, as text for your prompt. Types with their values (enums spelled out, which values were not returned to you), relationships, the Actions on them and whether you may invoke them, and the rules for using TypeSystem, within a token budget.",
      inputSchema: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", description: "The coding task in your own words, e.g. \"a page listing the orders that are late, with a button to escalate one\"." },
          focus: { type: "array", items: { type: "string" }, description: "Types or Actions to include whatever the task says." },
          maxTokens: { type: "integer", minimum: 500, maximum: 32000, description: "Upper bound on the context (default 4000)." },
          examples: { type: "integer", minimum: 0, maximum: 5, description: "Example objects per Type, as you are returned them (default 0)." }
        }
      },
      outputSchema: CONTEXT_OUTPUT,
      run: async (args, identity) => {
        const { task } = strings(`${p}compile_context`, args, ["task"]);
        const int = (name: string, min: number, max: number): number | undefined => {
          const v = args[name];
          if (v === undefined) return undefined;
          if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${p}compile_context: "${name}" must be an integer from ${min} to ${max}`);
          return v;
        };
        const focus = args.focus;
        if (focus !== undefined && (!Array.isArray(focus) || focus.some((f) => typeof f !== "string"))) throw new Error(`${p}compile_context: "focus" must be a list of names`);
        const maxTokens = int("maxTokens", 500, 32_000);
        const examples = int("examples", 0, 5);
        const c = await compileContext(runtime, identity, { task, ...(focus ? { focus: focus as string[] } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), ...(examples !== undefined ? { examples } : {}) });
        return { text: c.text, tokens: c.tokens, types: c.types.map((t) => t.name), actions: c.actions.map((a) => a.name), omitted: c.omitted, digest: c.digest };
      }
    },
    [`${p}describe_type`]: {
      description: "Describe a semantic Type: its JSON Schema, relationships, Actions, and computed properties.",
      inputSchema: stringArgs({ type: "The Type's qualified name (domain.Type), as resources/list gives it." }),
      outputSchema: TYPE_OUTPUT,
      run: async (args, identity) => {
        const { type } = strings(`${p}describe_type`, args, ["type"]);
        return readType(registry, runtime, type, identity);
      }
    },
    [`${p}get_object`]: {
      description: "Read one object by Type and id, with the provenance of each value. Properties you may not read are left out.",
      inputSchema: stringArgs({ type: "The object's Type.", id: "The object's id." }),
      outputSchema: OBJECT_OUTPUT,
      run: async (args, identity) => {
        const { type, id } = strings(`${p}get_object`, args, ["type", "id"]);
        return { ...(await readObject(runtime, type, id, identity)) };
      }
    },
    [`${p}get_relationship`]: {
      description: "Read the objects one object is related to through a named relationship. Objects you may not read are left out.",
      inputSchema: stringArgs({ type: "The source object's Type.", id: "The source object's id.", relationship: "The relationship's name." }),
      outputSchema: RELATIONSHIP_OUTPUT,
      run: async (args, identity) => {
        const { type, id, relationship } = strings(`${p}get_relationship`, args, ["type", "id", "relationship"]);
        return { objects: await readRelationship(runtime, type, id, relationship, identity) };
      }
    },
    [`${p}get_provenance`]: {
      description: "Where one property's value came from: source system, record, and time, and for a computed property, each input's.",
      inputSchema: stringArgs({ type: "The object's Type.", id: "The object's id.", property: "The property's name." }),
      outputSchema: PROVENANCE_OUTPUT,
      run: async (args, identity) => {
        const { type, id, property } = strings(`${p}get_provenance`, args, ["type", "id", "property"]);
        return { provenance: await readProvenance(runtime, type, id, property, identity) };
      }
    },
    [`${p}query`]: {
      description: "Run a structured semantic query against a Type, optionally including related objects.",
      // The exact schema (and limits) SemanticRuntime.query enforces, so an agent is told the real bounds.
      inputSchema: semanticQuerySchema(runtime.queryLimits),
      outputSchema: QUERY_OUTPUT,
      // Unchecked JSON is fine here: SemanticRuntime validates each shape before doing anything else.
      run: async (args, identity) => ({ ...(await runtime.query(args as unknown as SemanticQuery, identity)) })
    },
    [`${p}list_actions`]: {
      description:
        "The Actions on a Type and whether you may invoke each. Pass `id` to decide instance-scoped Actions on that object.",
      inputSchema: {
        type: "object",
        required: ["type"],
        properties: { type: { type: "string", description: "The Type." }, id: { type: "string", description: "Optional: one object of it." } }
      },
      outputSchema: ACTIONS_OUTPUT,
      run: async (args, identity) => {
        const { type } = strings(`${p}list_actions`, args, ["type"]);
        if (args.id !== undefined && (typeof args.id !== "string" || args.id === "")) throw new Error(`${p}list_actions: "id" must be a non-empty string`);
        const listed = await runtime.listActions(type, identity, typeof args.id === "string" ? { objectId: args.id } : {});
        return { actions: listed.map(summarizeAction) };
      }
    },
    [`${p}preview_action`]: {
      description:
        "Check what invoking an Action would do, with nothing executed: whether you're authorized, whether the input is valid, each precondition, and why it would not run.",
      inputSchema: {
        type: "object",
        required: ["action", "input"],
        properties: { action: { type: "string", description: "The Action's name." }, input: { type: "object", description: "The input you would invoke it with." } }
      },
      outputSchema: ACTION_PREVIEW_OUTPUT,
      run: async (args, identity) => {
        const { action } = strings(`${p}preview_action`, args, ["action"]);
        return { ...(await runtime.previewAction(action, args.input, identity)) };
      }
    },
    [`${p}invoke_action`]: {
      description:
        "Invoke an Action by name, as you would its own tool: for an Action typesys_discover or typesys_list_actions told you about that tools/list does not offer, since what tools/list offers can depend on who asks (ADR-0068).",
      inputSchema: {
        type: "object",
        required: ["action", "input"],
        properties: { action: { type: "string", description: "The Action's name." }, input: { type: "object", description: "The Action's input, as its inputSchema says." } }
      },
      outputSchema: { type: "object", properties: { result: {} } },
      // Any Action at all, so it claims nothing an Action might not honor.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: async (args, identity) => {
        const { action } = strings(`${p}invoke_action`, args, ["action"]);
        return { result: (await runtime.invokeAction(action, args.input, identity)) ?? null };
      }
    },
    [`${p}explain_query`]: {
      description:
        "How a typesys_query would run, without running it: each step in order, which part of the filter runs in the source system and which after objects are read, the related objects it would fetch, and what to expect (short pages, cost).",
      inputSchema: semanticQuerySchema(runtime.queryLimits),
      outputSchema: EXPLAIN_OUTPUT,
      // Only the execution plan: the authorization plan names what the policy tests and the caller's own values,
      // which ADR-0038 keeps to in-process callers.
      run: async (args, identity) => ({ ...(await runtime.explainQuery(args as unknown as SemanticQuery, identity)).execution })
    },
    [`${p}validate_query`]: {
      description:
        "Check a typesys_query against the model without running it: every Type, value, relationship and operator it names, with the name you probably meant. Valid does not mean you may read the results.",
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "object", description: "The typesys_query arguments to check." } } },
      outputSchema: VALIDATE_QUERY_OUTPUT,
      run: async (args, identity) => {
        const diagnostics = validateQuery(await runtime.describeModel(identity), args.query, runtime.queryLimits);
        return { valid: !diagnostics.some((d) => d.severity === "error"), diagnostics };
      }
    },
    [`${p}inspect`]: {
      description:
        "For a developer the deployment's inspection policy admits: where each value of a Type comes from, which policy (with its rule) and marking guard it, what each computed value derives from, is released from and reads, and which source each Action writes to. Refused to anyone else.",
      inputSchema: { type: "object", properties: { types: { type: "array", items: { type: "string" }, description: "Only these Types (default: every Type you may learn of)." } } },
      outputSchema: OPEN_OBJECT,
      run: async (args, identity) => {
        const types = args.types;
        if (types !== undefined && (!Array.isArray(types) || types.some((t) => typeof t !== "string"))) throw new Error(`${p}inspect: "types" must be a list of Type names`);
        return { ...(await runtime.inspectModel(identity, types ? { types: types as string[] } : {})) };
      }
    },
    [`${p}explain`]: {
      description:
        "Why a read, relationship, Action invocation or query is allowed, partly answered, refused or unavailable: the runtime's own decision replayed, each finding marked structural, evaluated or observed. Nothing is executed and no value is returned. Your own access by default; `as` (a subject id) explains someone else's, for an inspector only.",
      inputSchema: {
        type: "object",
        required: ["question"],
        properties: {
          question: {
            type: "object",
            description: '{"kind":"read","type","id"} | {"kind":"relationship","type","id","relationship"} | {"kind":"invoke","action","input"} | {"kind":"query","query"}'
          },
          as: { type: "string", description: "Optional: the subject whose access to explain." }
        }
      },
      outputSchema: OPEN_OBJECT,
      run: async (args, identity) => {
        const as = await subject(`${p}explain`, args.as, identity);
        return { ...(await runtime.explain(args.question as ExplainQuestion, identity, as ? { as } : {})) };
      }
    },
    [`${p}graph`]: {
      description:
        "The dependency graph of the model, its sources, policies and markings, and the workflows and applications built on it, as you may learn it. `overview` first; then `neighborhood`, `dependents` (what a change to a node reaches) or `dependencies` (what it rests on) of one node id such as `member:shop.Order.status`.",
      inputSchema: {
        type: "object",
        properties: {
          view: { enum: [...GRAPH_VIEWS], description: "Default overview." },
          node: { type: "string", description: "A node id from an earlier answer: type:, member:, relationship:, action:, source:, policy:, workflow:, app:, part:." },
          depth: { type: "integer", minimum: 1, maximum: 50 },
          limit: { type: "integer", minimum: 5, maximum: 400 }
        }
      },
      outputSchema: OPEN_OBJECT,
      run: async (args, identity) => {
        const view = args.view ?? "overview";
        if (typeof view !== "string" || !(GRAPH_VIEWS as readonly string[]).includes(view)) throw new Error(`${p}graph: "view" is one of ${GRAPH_VIEWS.join(", ")}`);
        for (const k of ["depth", "limit"] as const) if (args[k] !== undefined && (typeof args[k] !== "number" || !Number.isInteger(args[k]))) throw new Error(`${p}graph: "${k}" must be an integer`);
        const graph = await governedGraph(runtime, identity, extras.consumers ?? []);
        const node = typeof args.node === "string" ? args.node : undefined;
        if (view !== "overview" && view !== "full" && !graph.nodes.some((n) => n.id === node)) throw new Error(`${p}graph: no node "${node ?? ""}" in the graph you may see; start from view "overview"`);
        return queryGraph(graph, { view: view as GraphViewName, ...(node ? { node } : {}), ...(args.depth !== undefined ? { depth: args.depth as number } : {}), ...(args.limit !== undefined ? { limit: args.limit as number } : {}) });
      }
    },
    [`${p}aggregate`]: {
      description: "Run a grouped aggregation (count/sum/avg/min/max, optional groupBy) against a Type.",
      inputSchema: aggregateQuerySchema(runtime.queryLimits),
      outputSchema: AGGREGATE_OUTPUT,
      run: async (args, identity) => ({ ...(await runtime.aggregate(args as unknown as SemanticAggregateQuery, identity)) })
    }
  };
}

/**
 * The Actions `tools/list` offers as tools. Every one when discovery is open
 * (ADR-0068). Otherwise a list request carries no token of its own, so only
 * the Actions the runtime describes to whoever the transport resolves with
 * no in-band token (an HTTP request's bearer, or an anonymous caller, who is
 * offered none); `typesys_invoke_action` reaches the rest by name, for a
 * caller whose token travels in the call.
 */
async function listableActions(registry: SemanticRegistry, runtime: SemanticRuntime, resolveIdentity: IdentityResolver): Promise<ActionDefinition[]> {
  const actions = await registry.listActions();
  if (runtime.discovery === "open") return actions;
  let described: Set<string>;
  try {
    described = new Set((await runtime.describeModel(await resolveIdentity(undefined))).actions.map((a) => a.name));
  } catch {
    described = new Set();
  }
  // Names are still checked against the reserved prefix below, over every Action, so a misconfiguration is never hidden.
  const squatting = actions.filter((a) => a.name.startsWith(RESERVED_TOOL_PREFIX));
  return [...squatting, ...actions.filter((a) => described.has(a.name) && !a.name.startsWith(RESERVED_TOOL_PREFIX))];
}

/**
 * Actions map 1:1 onto MCP tools, beside TypeSys's own read, query, and
 * aggregate tools (ADR-0012, ADR-0051). Every call routes through the same
 * SemanticRuntime/PolicyEngine as any other consumer.
 */
export function registerToolHandlers(
  server: Server,
  registry: SemanticRegistry,
  runtime: SemanticRuntime,
  resolveIdentity: IdentityResolver,
  extras: Pick<McpBackend, "consumers" | "subjects"> = {}
): void {
  const builtIns = builtInTools(registry, runtime, extras);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const actions = await listableActions(registry, runtime, resolveIdentity);
    const squatting = actions.filter((a) => a.name.startsWith(RESERVED_TOOL_PREFIX)).map((a) => a.name);
    // Refuse loudly rather than hide the Action: a registry holding one is misconfigured, and listing the
    // rest would leave an agent unable to tell why an Action it was told about is missing.
    if (squatting.length > 0) {
      throw new Error(`Action names may not start with the reserved prefix "${RESERVED_TOOL_PREFIX}": ${squatting.join(", ")}`);
    }
    const tools: Tool[] = [
      ...actions.map((action) => ({
        name: action.name,
        description: action.description,
        inputSchema: withAuthToken(action.inputSchema) as Tool["inputSchema"],
        outputSchema: action.outputSchema as Tool["outputSchema"],
        annotations: actionAnnotations(action)
      })),
      ...Object.entries(builtIns).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: withAuthToken(tool.inputSchema) as Tool["inputSchema"],
        outputSchema: tool.outputSchema as Tool["outputSchema"],
        annotations: tool.annotations ?? READ_ONLY
      }))
    ];
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    // One top-level span per MCP tool call — see the matching comment in resources.ts.
    return withSpan("mcp.tools/call", { "mcp.tool.name": name }, async () => {
      const { authToken, ...rest } = (rawArgs ?? {}) as Args & { authToken?: string };
      const caller = await resolveIdentity(authToken);

      try {
        const builtIn = builtIns[DEPRECATED_ALIASES[name] ?? name];
        if (builtIn) {
          // Parsed back from the text, so both are exactly what crosses the wire (no undefined members).
          const text = JSON.stringify(await builtIn.run(rest, caller), null, 2);
          return { content: [{ type: "text" as const, text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
        }
        if (name.startsWith(RESERVED_TOOL_PREFIX)) throw new Error(`Unknown tool "${name}"`);

        const result = await runtime.invokeAction(name, rest, caller);
        const structuredContent = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(structuredContent ? { structuredContent } : {})
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }, { redactErrors: runtime.redactsTelemetryIdentifiers });
  });
}
